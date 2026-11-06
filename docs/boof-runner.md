# Boof Runner

Boof Runner is the code-execution runner of the boof project. It turns user tasks into a controlled local workflow that can plan, implement, review, and record code changes using coding-agent CLIs such as Claude Code, Codex and OpenCode.

Boof Runner is local-first. It runs on the user's machine, stores tasks as markdown files, serves a local web UI and API, and executes tasks against the registered git repositories (at most one task per project at a time).

## What It Does

Boof Runner manages the full lifecycle of coding-agent work:

- It accepts task prompts and plans of goals from the UI, the CLI, the REST API or MCP.
- It stores each task as a markdown file with validated frontmatter.
- It queues pending tasks by priority.
- It runs each task through planner, planner refinement, developer, and reviewer steps.
- It isolates code execution in a git worktree when the working directory is a git repository.
- It streams live agent output to the UI.
- It records durable reports, logs, status, token usage, and task history.
- It can park a task when the planner needs user input.
- It can stop a running task and inject extra user prompts while a task is running.

The product goal is not to replace a developer's judgment. Boof Runner automates the repetitive orchestration around coding agents while keeping the work observable, reviewable, and stored in plain files.

## How It Fits In boof

boof is the broader project (it also includes boof-planner, which writes `plan.boof.xml` and `goal.boof.xml` files). Boof Runner is the part responsible for code execution.

In this repository, Boof Runner is organized as seven workspaces:

- `@boof/heart` (`packages/heart`) owns shared schemas, file stores, lifecycle, plans, projects, and core process/git utilities.
- `@boof/owlish` (`packages/owlish`) provides the Owlish client and secret store; it depends on Heart.
- `@boof/runner` (`packages/runner`) owns the execution engine, pipeline, tool adapters, and worktree lifecycle; it depends on Heart and Owlish.
- `@boof/heart-server` (`packages/heart-server`) owns operations, services, OpenAPI, MCP, and the Hono server; it depends on Heart and Owlish.
- `@boof/facedisk` (`packages/facedisk`) contains both the React UI under `ui/` and CLI command implementations under `cli/`; its CLI depends on Heart and Heart server, while the UI uses Heart and Heart server types.
- `@boof/boof` (`bin/`) is the `boof-runner` composition root: it dispatches commands, scaffolds the data root, starts the web server, and ensures only one Runner is active. It composes Facedisk, Runner, Heart server, and their lower-level dependencies.
- `@boof/desktop` (`packages/desktop`) is the Electron wrapper that uses `@boof/boof` for boot, runs Heart server and Runner in-process, and opens the Facedisk UI.

Imports point down only: heart ← owlish ← runner; heart, owlish ← heart-server; heart, heart-server ← facedisk (the UI as types only); bin and desktop compose everything. The boundary test enforces this. Heart server never imports Runner; Runner never imports Heart server or Facedisk; Facedisk CLI never imports Runner or Owlish; the UI imports Heart and Heart server as types only, except the browser-safe `@boof/heart/ids`; bin never imports desktop. The root npm package and executable remain named `boof-runner`.

## Core Design

Boof Runner has a simple coordination model: the filesystem is the source of truth.

There is no database. The web server and runner both read and write the same data root. Atomic writes, in-process locks, and status-directory reconciliation keep that safe enough for the local single-user model (see Persistence And Safety for what holds within one process and across processes).

The default data root (layout v2, `settings.json` has `schemaVersion: 2`) contains:

```text
settings.json
events.jsonl
commands/
auth/
audit/
idempotency/
webhooks/                  # state, dead letters, secrets.json (signing secrets, mode 0600)
projects/
  <projectId>/
    project.json
    events.jsonl
    plans/
    tasks/
      drafts/
      pending/
      ongoing/
      actions/
      done/
      failed/
      stopped/
      archived/
      assets/
    usage.json
```

### Projects

A project is one git repository with its own queue. `project.json` (`ProjectSchema`) holds the `id` (the directory name, kebab-case), `name`, `workingDirectory` (a realpath, resolved when the project is created), `paused`, `archived`, an optional `defaultBase` ref, `labels`, `origin` (`ui`, `cli`, `api` or `migration`) and optional per-project overrides of `roles`, `review`, `worktree`, `retries` and `budget`. Global settings stay in `settings.json`; the runner merges them per key with the project's overrides (`effectiveSettings`), the project winning, and takes the working directory from the project.

Every task path helper takes a `root`. For a project that root is `projects/<id>/`, so `TaskStore`, `AttachmentStore` and `UsageStore` are used unchanged, one instance per project. Tasks do not store their project: the directory is authoritative, as it is for status. Ids are per project (two projects can both have a task `fix-login`); API responses add `projectId`.

Creating a project takes a path mode: `existing` (as before), `new` (boof makes the directory, runs `git init` and an empty first commit so worktrees can start) or `auto` (`<settings.projectsRoot>/<id>`, default `~/boof-projects`; a leftover non-empty directory moves the id on, `shop`, `shop-2`, …). A non-empty directory is initialised only with `confirm`; a directory boof created is removed again when registration fails afterwards. The optional `brief` in `project.json` is added to every agent prompt as `## Project`, right after the task title.

Creating a project (`ProjectStore.create`) resolves the realpath, requires a git work tree (the check is injected by the caller, so `shared` does not depend on `runner`), refuses a directory inside the data root or one that is already a project, and derives the id from the directory name. It also refuses a directory whose git common dir (`git rev-parse --git-common-dir`) is already another project's, archived or not: two projects in one repository would share the `boof-runner/<id>` branch namespace and the worktree bookkeeping. Subdirectories and linked worktrees of a registered repository share its common dir, so they are refused too. The API answers `409 project_exists`. Registering or unarchiving a project runs `git worktree prune` in it at once (the runner loop also prunes every project when it starts), so a repository whose task worktree directories were deleted by hand does not wait for a restart. A project with an empty `workingDirectory` can only come from migrating a v1 data root that never had one; the runner skips it until a directory is set.

### Migration from v1

`migrateDataRoot` (shared) runs before any store opens: at server start, in the desktop app, and in `run`, `scan` and `project`. It holds `<root>/.migration.lock` (the pid of the process) while it works; a second process waits for the lock, then re-reads `settings.json` and finds the root current. A lock whose pid is dead is taken over. A missing `settings.json` becomes v2 defaults with no projects. A `settings.json` without `schemaVersion` is v1: `projects/default/project.json` is written from the old `workingDirectory`, `tasks/` and `usage.json` are renamed into `projects/default/`, then `settings.json` is rewritten last as v2 (`defaultProject: "default"`, `runner.concurrency: 1`, removed keys dropped) and `migration-v2.log` records what moved. Because the settings file changes last, a crash leaves a v1 file and the next start finishes the remaining steps; each step checks its own precondition. The migration refuses (and changes nothing) when `tasks/ongoing/` holds a task and `.runner.pid` names a live process. Worktrees live in the repository and are keyed by task id, so they are untouched. On a v2 root it also backfills `approvedBy` (principal `migration`) on active plans that were activated before approvals were recorded and logs each one. Current code records the approval whenever it activates a plan (the API, and the CLI's `plan import` and `scan`, as principal `local` or the acting principal), so on a current root this only meets plans from before approvals existed; the check itself is a cheap scan of every plan on each start. A plan whose backfill write fails is logged and retried at the next start.

Task state is represented in two ways:

- The task file's frontmatter has a `status` field.
- The task's physical directory also represents status.

If those disagree, the directory wins. That makes queue queries simple and lets crash recovery repair mismatched frontmatter.

## Task Files

Each task is a markdown document with structured frontmatter and named body sections. The frontmatter stores operational fields such as:

- `id`
- `title`
- `status`
- `priority`
- `skip`
- `labels`
- `command`
- `attachments`
- `questions`
- `runs`
- `completedRuns`
- `base` (optional): branch name or commit the task's worktree starts from
- `startedAt` (optional): when the task last entered `running`; kept after the run ends
- `steps` (optional): the current run's pipeline step headers, each `{ label, at }`, in order; reset when the task enters `running`. The run's last entry is `Finished`, `Failed` or `Stopped` with the time the run ended (the UI uses it as the last step's end); a parked run has none
- `epicId` (optional): the task's epic, a record in the project's `epics.json`. A subtask has no `epicId` of its own; its epic is its parent's
- `parentId` (optional): the parent task. One level only: a parent has no parent, and a task with subtasks cannot get one. Both keys resolve inside the task's own project; a missing target loads fine and the task is treated as top-level. A file without either key is a top-level task without an epic. Hand edits are read leniently: an emptied key, a list or a non-kebab value counts as absent (it is gone on the next write), `epicId: none` is ignored (`none` is the "no epic" filter value) and an integer reads as its string
- per-task tool overrides
- token usage
- timestamps

The body stores human-readable content:

- original prompt
- injected command text
- planner questions
- user answers: every round is kept, appended as `Round N:` then `Questions:` and the numbered questions, then `Answers:` and the reply (no `###` headings, which are reserved for reports); `questions` always holds only the latest round and the planner prompt receives all rounds
- planner/developer/observer/reviewer reports (observer and reviewer sections hold one entry per round, with its verdict)
- raw execution log

A line inside a section that would start another section (`## Log`, `### Reviewer`, ...) is stored indented by one space; only the first occurrence of each heading opens a section.

Epics and subtasks. A project can hold epics (`epics.json`), and a task can sit in one (`epicId`) or under a parent task (`parentId`, one level). A subtask has no epic of its own; it shows its parent's. Progress is derived and never stored: a task shows `done/total` of its non-archived subtasks and an epic `done/total` of its non-archived top-level tasks. Deleting a task with subtasks or an epic with tasks is refused unless `detach` is given. The scheduler ignores the hierarchy; queuing a parent whose subtasks are not done only adds a `subtasks_open` warning. CLI: `epic add|list|archive|remove`, `task list|move`, and `run --epic <id>` / `run --parent <id>`.

This format keeps task data editable, inspectable, and portable outside the app.

## Plans

A plan is an ordered DAG of goals for one project, stored as `projects/<id>/plans/<planId>.json`. A goal has an id, title, optional repo-relative `path`, `order`, `dependsOn`, `status` (`plan|develop|review|done`), an optional `model` hint, a `spec` (goal, stack, do/don't rules, tests) and a `history` of status entries. The spec maps one to one onto a boof-planner `goal.boof.xml`.

Plan fields: `status` (`draft`: never synced; `active`: syncable; `archived`), `autoSync` (the engine syncs the plan at the start of each tick and before it starts tasks), `bumpTo` (`review` or `done`: the status recorded when a task finishes), `source` (`ui|api|mcp|repo-import`, plus the creating client) and `version`.

Validation (`validatePlan`): unique goal ids, dependencies that exist, no cycles, and an `order` consistent with the dependencies. Writes renumber `order` 1..n along the topological order that is closest to the given one. A goal path must be relative and may not contain `..`.

Each goal has a `revision`. It goes up by one whenever the spec, `dependsOn` or `model` changes (title, path and order do not count). `PlanStore` keeps `version` optimistic: `save` needs the version that is stored right now or throws `PlanVersionConflict`. The API maps that to `409 plan_version_conflict`.

### Sync

`plan sync` / `POST …/plans/:planId/sync` works on `active` plans and is idempotent. Goals are walked in order. A goal that is not `done` and whose dependencies are all `done` gets a task if no task exists for its current revision: title `boof: <goal title>`, labels `plan:<planId>`, `goal:<goalId>` (plus `boof-scan` and `boof-status:<status>` for imported plans), priority `(open goals − position) × 10`, `planRef {planId, goalId, revision}`, `promptSource: plan`, `base` = the project's default base, status `pending`. The prompt is the unit prompt (goal, stack, rules, tests, TDD, do not edit the plan files) plus a `## Plan` section. A goal may name an `epicId`: sync copies it onto the goal's task when the task is created and again when it changes, unless a human made the task a subtask; a goal without one never changes the task's `epicId` or `parentId`, and sync never sets or clears `parentId`. The epic is not part of the goal's content (no revision bump), is kept when an import or an edit omits it, and is cleared by `epicId: null`; an epic that does not exist leaves the task with `epicMissing`. Tasks start in `draft` when the plan was created by a `review`-trust client and `security.externalTasksRequireApproval` is on (and for any sync a `review`-trust client triggers).

A goal whose dependencies are not done gets no task (reported as `skipped: blocked`). A pending task of a goal that became blocked is skipped with the label `blocked`; it is unskipped when the goal is unblocked. `scan` asks for blocked tasks up front (`includeBlocked`) so every not-done unit has a task.

When a goal changes, the next sync applies this table:

| Task state                                        | Action                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `draft`, `pending`, `action`, `failed`, `stopped` | Rewrite the prompt from the new spec, set `planRef.revision`, add a `## Plan change` note to the task log. A failed or stopped task keeps its status (retry it); an `action` task keeps its questions. If `promptSource` is `manual` (the prompt was edited by hand) the diff is appended instead and the label `needs-review` is added. |
| `running`                                         | Append an instruction to the control-dir prompt injections (same mechanism as the inject endpoint) naming the new revision and the field changes, once per revision; add the label `stale-revision` (best effort, the pipeline also writes the task file). The injection is read between steps, so a change lands at the next step.      |
| `done` at an older revision                       | The goal goes back to `develop` (history entry `spec changed to revision N`) and a follow-up task `Update <goal> to revision N` is created. Its prompt holds the previous spec, the new spec, the field changes and a unified diff.                                                                                                      |
| goal removed                                      | `pending`/`draft` tasks are archived with the label `goal-removed`; a running task gets a stop request only with `stopRunning`; done tasks stay.                                                                                                                                                                                         |

The previous spec comes from `goal.synced`, the spec the latest task prompt was built from. A task archived by a user at the current revision is not recreated; a new revision gets a new task.

### Status write-back

When a plan task reaches its final `done`, the engine appends a history entry `{revision: planRef.revision, status: plan.bumpTo, description: "boof-runner completed task <id>"}` to the goal, clears `taskId` and saves the plan (retrying against concurrent API writes). If the goal has a `path` and the project's `planWriteBack` is true (the default), it also appends the same `<version>` to `<workingDirectory>/<path>/goal.boof.xml`, so boof-planner keeps working. Write-back errors are logged and never fail the task. Tasks with the old `boofGoal` frontmatter finish as before.

### Import and export

`plan import` scans the repo (`goal.boof.xml`, `plan.boof.xml`) into goals: path, order, dependencies, status from disk, spec and version history. Re-importing into an existing plan matches goals by path, then id; a changed spec bumps the revision, and the repo status is adopted only when it is further along than the plan's. Export returns `plan.boof.xml` and every `<path>/goal.boof.xml` as a map of file name to content (the CLI writes them under `--out`); untouched goals round-trip byte for byte. Boof never writes into the repo during export.

### Trust

`review`-trust clients create `draft` plans, cannot set `active`, and cannot change a plan that is `active` (their edits would reach the queue unreviewed); a human approves by setting `active`. Stopping tasks of removed goals needs `tasks:control`.

## Runner Pipeline

The runner polls `tasks/pending/` of every active, non-paused project that has a working directory and chooses across all of them: highest `priority`, then oldest `updated`, then project id (then task id) so the order is deterministic. It transitions the chosen task to `projects/<id>/tasks/ongoing/<task-id>/` and builds the pipeline with the project's effective settings. Epics and subtasks play no part in the choice. Every prompt of a task that has an epic, a parent or subtasks carries a `## Hierarchy` section right after `## Project`: the epic (its title when a human created the epic, only its id when a client did), and the parent with its other subtasks (or the task's own subtasks), as titles and statuses only. Drafts and archived tasks are left out, and a review-trust client cannot retitle a task once a human queued it, so text no human approved does not reach an agent through a human's task; the list stops at 50 entries.

### Agents are not sandboxed

A task agent (`claude`, `codex`, `opencode`) runs as **your OS user**, in the task's worktree, with every permission prompt skipped. It can read and write any file you can, and it can call boof's own API at `http://127.0.0.1:<port>`. Under `security.auth.mode = "local-trust"` (the default) a request from the loopback address without a key is the **local administrator**, so an agent (or a prompt injected into one) can queue tasks, create API keys and webhooks, change settings, and edit the data root directly. boof limits what agents _inherit_; it does not isolate them, and this is not a sandbox. Run agents only on repositories and prompts you trust, or run boof under a separate OS user or container. With `security.auth.mode = "required"` the API answers `401` without a key, which closes that route (the agent holds no key and gets none), but the data root and your files stay readable.

What boof does limit:

- **Environment.** Agents get an allowlisted environment, not the server's: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`/`TMP`/`TEMP`, `TZ`, `XDG_*`, proxy and certificate variables (`HTTP(S)_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_*`), the Windows basics, and each tool's own variables (`ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*`, `CODEX_*`, `OPENCODE_*`, so a gateway base URL and keys keep working). Everything else is dropped (cloud credentials, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`), and so is every `BOOF_*` variable, which names boof's key, URL, data root and port. `settings.runner.agentEnv` (a list of names, default none) passes more variables through; a `BOOF_*` name in it is ignored. The health probe uses the same environment. `claude-agent` is the exception: its child gets the shorter list described under [The claude-agent tool](#the-claude-agent-tool), and `settings.runner.agentEnv` does not apply to it.
- **MCP servers.** `claude` runs with `--strict-mcp-config` (and no `--mcp-config`), so neither `~/.claude.json` nor the repository's `.mcp.json` loads. `codex` runs with `--ignore-user-config`, so it does not read `$CODEX_HOME/config.toml` (its MCP servers live there; login still comes from `CODEX_HOME`); boof passes approval mode and sandbox mode explicitly. An empty model uses the Codex CLI built-in default; a `model` in config.toml is ignored along with `model_provider` and `base_url`. Set `settings.runner.inheritMcpServers` to `true` to load those config values, including its model. `opencode` reads its MCP servers from its own config (`opencode.json`) and boof knows no flag that drops them, so keep servers you do not want agents to use out of that config. `settings.runner.inheritMcpServers` (default `false`; `PUT /settings` with `{"runner":{"inheritMcpServers":true}}`) turns all of this off. The health probe and model listing are not affected.

### Concurrency

`settings.runner.concurrency` (default 1) is the number of tasks in flight. The invariant is **at most one running task per project**: the engine keeps a map of in-flight pipelines by project id and `selectNext()` skips those projects, because worktree creation, the `.meta` sidecar and branch creation in one repository are not race-safe. With concurrency 2 two projects can run side by side; two tasks of one project never do. Concurrent agent CLIs share CPU, memory and API rate limits. The mock tool's `mockState` is module-global, so tests that run tasks concurrently track their own state in the `onRun` hook instead of relying on `mockState.prompts` or `calls`.

For each task, the pipeline runs these steps:

1. Planner
   Creates an implementation plan. If it cannot proceed without user input, the task is parked in `actions/`. It asks by ending its report with a fenced ` ```questions ` block, one question per line; every adapter parses that block (`parseQuestions`), so a real planner parks the task exactly like the mock.

2. Planner refinement
   Reads the first plan and produces a refined final plan.

3. Developer
   Implements the plan in the working directory or isolated worktree.

4. Observer (optional)
   A second model checks the task prompt, the final plan and the diff against the worktree base, and ends its report with a verdict.

5. Reviewer
   Gives the final review of the diff and ends its report with a verdict.

Developer, observer or reviewer questions are routed back to the planner internally. They ask with the same block. The planner answers, the asking role runs again with the answers in its prompt (`## Answers from the planner to your questions`; one extra run, it cannot ask twice in a row), and the exchange is added to the task's Questions section. A reviewer's or observer's verdict is the one from that second run. If the planner itself cannot answer (its answer ends with a `questions` block), the task parks with those questions, each marked with the role that asked; after the owner answers, the pipeline runs again and every step, the asking role included, sees the answers under `## Answers to earlier questions`. Both extra runs are ordinary steps: their cost is recorded and the budget is checked before each starts. Only planner questions that block the original task are surfaced to the user.

### Observer Role

The observer is configured with `settings.roles.observer` (`{ "tool", "model" }`) or per task with `tools.observer` in the frontmatter; the per-task value wins. When neither is set there is no observer step. The Settings page shows the assignment and offers `(none)` to unset it. Task files without an `### Observer` report section still parse.

### Verdict Protocol

The observer and reviewer system prompts also tell the agent to experiment in a temporary directory outside the working directory and to leave the working tree exactly as found (revert edits to tracked files, delete anything it created), so the leftover auto-commit never sweeps scratch files into the branch.

The observer and reviewer system prompts require the report to end with exactly one line:

- `VERDICT: APPROVE`
- `VERDICT: CHANGES_REQUESTED`, with the findings listed above it
- `VERDICT: REJECT`, for work that should not be fixed in place

`parseVerdict(report)` (in `@boof/heart`) is strict and case-sensitive; it ignores trailing whitespace and markdown emphasis characters (`*`, `_`, backticks) around a line. The last non-empty line must match `^VERDICT:\s*(APPROVE|CHANGES_REQUESTED|REJECT)\s*$`. Any other exact verdict line anywhere in the report with a different verdict makes the result INVALID, even across blank lines; identical repeated verdict lines are fine. It fails closed: a missing verdict, a malformed one, text after the verdict line, or conflicting verdict lines all mean not approved.

The codex report is the file written by `codex exec --output-last-message`; stdout is the fallback when that file is missing or empty. The prompt is passed on stdin (`codex exec … -`), so its size is not limited by the argv limit.

### Review Gate And Fix Loop

With `settings.review.gate` (default `true`) the flow is developer, observer (if configured), reviewer:

- Observer `CHANGES_REQUESTED`: the developer re-runs in the same worktree. Its prompt holds the findings, the plan and the instruction to fix each real finding with a test, or rebut it with evidence. The observer then re-checks. This repeats until `APPROVE` or until `settings.review.maxFixRounds` (default `2`) is spent.
- Reviewer `CHANGES_REQUESTED`: the developer fixes, the observer (if configured) re-checks until `APPROVE` within the observer's budget, then the reviewer re-checks. The reviewer has its own `maxFixRounds` budget. The observer budget is shared across the whole run.
- `REJECT` from either, an invalid verdict, or a spent budget: the task fails with `review not approved: <role> <verdict>` (`INVALID` for a missing or malformed verdict). The worktree and branch are kept, as for every failed task.
- Only a reviewer `APPROVE` lets the task finish as `done`.

With `gate: false` the observer still runs if configured and the reviewer runs once, but verdicts are only recorded, never enforced. Every observer and reviewer report is stored with its round number in the task's `### Observer` and `### Reviewer` report sections, and each verdict is written to the task log (`Observer verdict (round N): X`). With `runs > 1` the full gate repeats each iteration.

### Review Settings

All keys are optional with defaults:

```json
{
  "roles": { "observer": { "tool": "claude-code", "model": "sonnet" } },
  "review": { "gate": true, "maxFixRounds": 2, "maxInlineDiffBytes": 120000 }
}
```

- `review.gate`: enforce verdicts (default `true`).
- `review.maxFixRounds`: developer fix rounds allowed per reviewing role (default `2`).
- `review.maxInlineDiffBytes`: largest diff inlined in observer, reviewer and developer-fix prompts (default `120000`): the diff of tracked files plus a `--no-index` patch for every untracked file (at most 200). Over the limit, the prompt carries the `--stat` summary, the untracked-file list and a note giving the base sha and telling the agent to run `git diff <base>` (per file `git diff <base> -- <path>`; untracked files `git diff --no-index -- /dev/null <path>`). The log records `Diff exceeds inline limit`.

### Mock Verdicts

The mock tool emits scripted verdicts for offline tests. Put a marker in the task prompt: `[[mock-verdicts observer=CHANGES_REQUESTED,APPROVE reviewer=APPROVE]]`. Each role takes one token per round and the last token repeats. Tokens: `APPROVE`, `CHANGES_REQUESTED`, `REJECT`, `NONE` (no verdict line), `GARBLED` (`VERDICT: MAYBE`), `CONFLICT` (two disagreeing final lines). The marker must sit on one line, the last complete marker in the prompt wins, and unknown tokens throw. Without a marker, the mock observer and reviewer approve.

When a task has `runs > 1`, Boof Runner re-queues it after each completed run until `completedRuns` reaches `runs`. Later runs include framing that asks the agent to critically review and improve the previous run's work.

## Code Execution And Isolation

When the project's `workingDirectory` is a git repository, Boof Runner creates a dedicated git worktree for a running task. Agent tools execute inside that worktree, not directly in the main checkout.

`git worktree add`, the leftovers snapshot and `git worktree remove` may take up to 15 minutes on a large repository; other git calls are killed after 30 s. An add that fails or is killed removes its registration, directory and newly created branch before the task fails, so a retry starts from a clean checkout.

This matters because the agents run in auto-approve mode. Worktree isolation gives Boof Runner:

- a contained place for file mutations
- a clear diff for review
- work that is never destroyed under the defaults:
  - Task branches `boof-runner/<id>` are never deleted unless you opt in (see Retention Policies).
  - On done, the task branch keeps only the commits the agents made deliberately. Uncommitted leftovers (including untracked files and scratch directories) are **not** committed onto it. They are saved on a side branch `boof-runner/<id>--leftovers`, created from the task branch head with a temporary index, so the task branch and its worktree stay untouched. The log records the side branch name and sha. Then the worktree directory is removed (`git worktree remove --force`; safe because leftovers are saved). If saving the leftovers or the removal fails, the directory is kept and the reason is logged.
  - On `failed` or `stopped`, the worktree directory and the branch are kept as they are. The directory path, branch name and HEAD sha are logged.
  - On retry, an existing task branch is reused (and `base` is ignored, which the log says). An unregistered directory at the worktree path fails the task and is never touched.
  - For done and failed tasks the branch name and HEAD sha are recorded in the task log.
- protection against one task corrupting the main working tree

If the configured directory is not a git repository, Boof Runner can run without isolation, but it records a warning and loses the worktree safety guarantees.

### Base Ref

Optional task frontmatter `base` (a branch name or commit) makes the task's worktree start from it instead of the working directory's HEAD. From the CLI: `boof-runner run --base <ref>` (and `--title <text>` to set the task title). Boof Runner resolves it first with `git rev-parse --verify --quiet <base>^{commit}`. An unknown ref fails the task with `unknown base ref '<base>': not a branch or commit in <dir>` before any branch or directory is created. The resolved sha is the worktree's `base` used for diffs, and the log records `base <ref> → <sha>`. When the task branch already exists and is reused, `base` is ignored and the log says so.

### Settings: worktree

All keys are optional with defaults, so existing settings files keep working:

```json
{
  "worktree": { "root": "~/boof-worktrees", "onDone": "keep-branch", "onFailure": "keep" }
}
```

- `worktree.root`: directory holding the task worktrees. Default `<workingDirectory>/.boof-runner-worktrees`. A relative path resolves against `workingDirectory`; a leading `~/` expands to the home directory. Task worktrees live at `<root>/<taskId>` and the meta sidecar under `<root>/.meta/`, so worktrees can live outside the repository. A root inside the repository should be gitignored.

### Retention Policies

- `worktree.onDone`:
  - `"keep-branch"` (default): leftovers go to `boof-runner/<id>--leftovers`, the directory is removed, the task branch is kept.
  - `"keep"`: leftovers go to the side branch, and the directory is left in place too.
  - `"delete"` (opt-in): remove the directory and delete the task branch and its `--leftovers` branch. The log says `WARNING: DELETED task work`.
- `worktree.onFailure`:
  - `"keep"` (default): keep directory and branch.
  - `"delete"` (opt-in): same loud deletion. A stopped task always keeps its work.

Nothing is ever deleted under the defaults. Removing a directory also drops ignored files such as `node_modules`; a nested git repository in the leftovers cannot be saved (skipped if it has no commit, a bare gitlink otherwise), so the directory is then **kept** and the log names the paths. Move or commit them, then remove the directory yourself.

## Transient Retries And Stalls

A tool step that fails with a transient API error is retried in the same worktree instead of failing the task. Settings (all optional):

```json
{ "retries": { "transient": 2, "backoffMs": [30000, 120000], "idleTimeoutMs": 1200000 } }
```

- `retries.transient`: retries per step (default `2`; `0` disables). The budget is per step and covers every step, including the planner answering a question.
- `retries.backoffMs`: delay before each retry (default `[30000, 120000]`; the last entry repeats).
- `retries.idleTimeoutMs`: kill a tool step that produces no output chunk for this long (default `1200000`, 20 min). The process gets SIGTERM, then SIGKILL, as for stops, and the failure counts as transient (`stalled: no output for N min`). Agents' long commands still stream tool-call events, so this only fires on a true stall.

A failure is transient when it is a tool error that was neither stopped nor timed out, and its output or stderr matches `API Error: 5xx`, `429`, `529`, `overloaded`, `temporarily unavailable`, `ECONNRESET`, `ETIMEDOUT` or `socket hang up` (exported as `isTransientToolError()`), or the stream stalled. Every retry is logged (`Transient failure in <step> (attempt a/n): …; retrying in Xs in the same worktree`). The stop signal is checked during the backoff: a stop request stops the task as usual. The retried step's prompt gains a `## Previous attempt interrupted` section telling the agent that the working directory may hold partial changes and to inspect `git status` and `git diff` and continue rather than restart. Non-transient errors, timeouts and stops are not retried. Every attempt is recorded in the ledgers and on the task, and the budgets are checked before a retry starts.

The mock tool can simulate both: `[[mock-transient developer=1]]` fails the first N runs of a role with `API Error: 503`, and `[[mock-stall developer=1]]` makes them go silent.

## Budget Limits

`settings.budget` and the project's `budget` override stop spending; the README's [Budget limits](../README.md#budget-limits) table lists the keys. Design points:

- The choke point is `Pipeline.runStep`. After a tool step returns, its cost is added to the run total and to the daily ledgers (`recordSpend` in `packages/heart/src/budget.ts`: `<data>/usage/daily/<date>.json` for everything, `<project>/usage/daily/<date>.json` for one project; atomic writes under the per-path lock; the date is the day in `budget.timezone`). Before the next step starts, `assertBudget` compares the run total with `perTaskUsd` and evaluates the day scopes that apply (`global`, `project:<id>`, `tool:<t>`, `project:<id>/tool:<t>`); a spent scope throws `BudgetExceededError` (`budget exceeded: <scope> <spent>/<limit> USD`) and the task fails through the normal failure path. A step is never killed for budget, because a CLI step cannot be interrupted at a cost boundary; the last step of a run can overshoot, and its cost is recorded without failing the run. A `ToolRunError` carries the usage of the failed attempt (transient, steered or final); it is recorded like a result.
- Selection (`RunnerEngine.selectWithBudget`) skips projects and tasks (by the tools of all four roles) whose day scope is spent and reports them. When nothing can start and something was skipped, `tick()` returns `{ kind: "budget", scopes }` and `runUntilIdle()` ends with that result instead of `idle`. `runner.budget_exceeded` is appended to `<data>/events.jsonl` once per day and scope (the marker is the `notified` list in the global ledger, so a restart does not repeat it); project scopes carry `project`.
- **Account pool gate** (`settings.owlish`, `PoolGate` in `packages/runner/src/pool-gate.ts`). With `healthGate: "pause"`, a task whose roles use a pool-routed tool (`acceptsPool`) does not start while better-ccflare is degraded, unhealthy or unreachable; other tasks run. The reason is in `runner.status.pool` and the tick result (`kind: "pool"`); one `runner.pool_exhausted` event is written per blocked episode and selection resumes by itself when health returns. The gateway is asked at most every 30 s (sooner only once a known `nextAvailableAt` has passed). A running step that is about to use a pool-routed tool waits in place (task stays `running`, log line `### Waiting for the account pool (...)`) for at most `retries.poolWaitMs` (default 30 minutes), then fails `pool exhausted` and keeps the worktree when the budget `onExceed` is `pause`. A proxy 5xx while the pool is unusable waits for the pool instead of spending a retry. `warn` only reports; `off` does not look; without `settings.owlish` nothing changes. For `claude-agent`, a network error, timeout or 5xx while checking gateway account eligibility is also an outage: selection leaves the task pending, and a running step waits up to `retries.poolWaitMs` before failing. A 401/403, subscription account or malformed answer refuses or uses the project's key. Pool-routed claude-code, codex and opencode still receive the admin client key as before; only claude-agent uses the separate agent key.

- `onExceed: "pause"` keeps the worktree and branch whatever `worktree.onFailure` says; `"fail"` follows it. Both fail the task; a day budget that is spent blocks new work in its scope until midnight (in the budget zone) for both.
- Usage with `known: false` counts as 0 and increments `unknownSteps`; a tool without cost reporting is therefore unlimited. Codex reports token counts but no price, so its steps are unknown and `perToolDayUsd` cannot limit it; ledgers written before this change keep what they recorded.
- The cost that `claude-agent` reports is the SDK's own estimate, not a bill. When any model entry has `costBasis: "unknown"` (a guessed price), the usage is recorded with `known: false`, so it counts as 0 and increments `unknownSteps`. The SDK reports cumulative totals. On a resumed session boof subtracts the totals of the earlier session when they are present; a valid delta keeps its known status. If the SDK restarted its totals, boof charges that attempt's reported usage with `known: false` rather than treating the attempt as zero.
- Spent means `spent >= limit`. Per-task cost counts the current pipeline run only.
- Read side: `evaluateBudget` (shared) powers `GET /api/v1/usage/budget`, the `budgetExceeded` list in `runner.status` and `runner.overview`, and the UI.
- The mock tool takes `[[mock-cost 0.5]]` (every step costs $0.50) or `[[mock-cost unknown]]` (no usage reported); the default is $0.01.

### Optional account pool (better-ccflare)

**Account pooling by [better-ccflare](https://github.com/tombii/better-ccflare) (MIT, © 2025 snipeship & tombii), a fork of ccflare by snipeship.** Boof calls its gateway over HTTP. Set `settings.owlish` to `{ "url": "http://127.0.0.1:8080", "healthGate": "pause" }`; `healthGate` accepts `pause`, `warn` or `off` and defaults to `pause`. With the setting absent, boof makes no pool health request and does not gate selection. When configured and the gateway is down, the `pause` gate pauses selection of tasks whose role uses a pool-capable tool, with a visible reason in `runner.status.pool`. `warn` exposes health without blocking; `off` disables the gate.

The client key is optional. Set it once through the write-only `owlishApiKey` input of `settings.update`, or set `BOOF_OWLISH_API_KEY`; the environment value wins. Otherwise the key is stored at `<data>/owlish/secrets.json` with file mode 0600 (and its directory mode 0700). Boof never handles provider credentials. Sign-in and account addition take place in the better-ccflare dashboard. The key is never returned by settings reads or by the one-time set response.

An optional second key, `owlishAgentKey` (env `BOOF_OWLISH_AGENT_KEY`, which wins), is an **api-only** better-ccflare key used only by `claude-agent` processes. It is write-only, kept in the same `secrets.json` (mode 0600, under the same lock) and never returned; reads show only where it comes from (`agentKeySource` in `accounts.health`). `null` removes the stored key.

Account operations are generated from the same registry as REST and MCP: `boof-runner accounts list`, `pause`, `resume`, `priority`, `thresholds` and `health`. Use the generated command help for required flags and arguments. Reads need `settings:read`. Account changes and gateway settings need `settings:write` plus a trusted, project-unrestricted principal; `review-trust` and `local-mcp` cannot change accounts or gateway settings. The pool is shared across projects. A running pipeline waits in place up to `retries.poolWaitMs` (default 30 minutes) when it reaches a pool-unavailable step; the task remains running during the wait.

Routed agents receive the gateway client key in their process environment and can call ccflare's `/api/*` endpoints directly with it, bypassing boof's account-operation authorization. See [Agents are not sandboxed](#agents-are-not-sandboxed) and the [agent-containment goal](superpowers/specs/2026-10-29-boof-roadmap.md).

**Compliance gate for `claude-agent`.** Anthropic allows the Agent SDK only with API-key authentication. `claude-agent` therefore uses the gateway only when the gateway's account list could be read and **every** pool account, paused ones included (routing can unpause them or fall back to them), is one of the API-key providers and has no refresh token. The providers are `claude-console-api`, `bedrock`, `vertex-ai`, `zai`, `minimax`, `deepseek`, `anthropic-compatible`, `openai-compatible`, `nanogpt`, `kilo`, `openrouter`, `alibaba-coding-plan`, `ollama`, `ollama-cloud` and `meta` (better-ccflare's own API-key set at v3.6.3). The gate closes, and fails closed, for `anthropic` (subscription OAuth, or an ambiguous legacy console account), `codex`, `codebuddy`, `qwen`, `xai`, an unknown or missing provider, an account with a refresh token, an empty list, an HTTP error or a malformed answer. The decision is made again, without the 30-second cache, before every attempt of a step (see Gate order below).

| Project choice | Gateway gate         | Project key | Result                                  |
| -------------- | -------------------- | ----------- | --------------------------------------- |
| `project-key`  | not asked            | set         | uses the project's key                  |
| `project-key`  | not asked            | not set     | task does not start                     |
| `gateway`      | open                 | any         | uses the gateway                        |
| `gateway`      | closed or no gateway | set         | uses the project's key, with a log note |
| `gateway`      | closed or no gateway | not set     | task does not start                     |

The check needs a better-ccflare **admin** client key; an api-only key gets HTTP 401 and keeps the gate closed. `accounts.agentSdk` (`boof-runner accounts agent-sdk`, MCP `boof_get_agent_sdk_eligibility`, `GET /api/v1/accounts/agent-sdk`) shows the verdict and the blocking accounts without starting anything. A `claude-agent` step routed through the gateway counts as pool-routed for the pool gate above; a step on the project's own key does not. The Accounts tab shows an "Agent SDK" badge per account. Subscription accounts stay on `claude-code`.

Gateway URLs must use HTTPS except for loopback hosts (`localhost`, `localhost.`, `127.0.0.0/8`, or `[::1]`). Hostnames must use ASCII DNS labels (IDNA/punycode is allowed) or a bracketed IPv6 literal. Credentials, query strings and fragments are rejected. Routed agents receive the gateway client key in their process environment and can use it to call the gateway API directly.

## Non-Interactive Guard

Every role's system prompt (planner, refinement, developer, observer, reviewer, planner-answering) ends with a guard: the tool runs non-interactively, its process exits when the turn ends and kills anything in the background, so the agent must never end its turn while waiting on background work. Commands longer than about 10 minutes run in the background with an exit-status marker file and are awaited with repeated foreground loops under 10 minutes.

## Findings Across Iterations

With `runs > 1`, from iteration 2 on, every step's prompt gains `## Findings from the previous iteration`: the final observer report (if any) and final reviewer report of the previous iteration, verdict lines included.

## Tool Adapters

Tools are behind a shared `Tool` interface. The pipeline does not know how Claude Code, Codex or OpenCode are invoked; it only calls the registered tool.

Built-in tools:

- `claude-code`: runs the `claude` CLI in non-interactive mode. This stays the default tool for every role.
- `claude-agent`: opt-in. Runs Claude Code through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, pinned to 0.3.318), so a running step can be steered in place. See [The claude-agent tool](#the-claude-agent-tool) for the rules that gate it.
- `codex`: runs the `codex` CLI in non-interactive mode.
- `opencode`: runs `opencode run --dir <worktree> -m <model>` (adding `--auto` in auto mode) with the prompt on stdin. Models come from `opencode models`; default `opencode-go/kimi-k3`. Override the binary with `BOOF_RUNNER_OPENCODE_BIN`.
- `mock`: deterministic offline tool used by tests.

Each tool can:

- report health
- list available models
- run a role-specific prompt
- stream output chunks
- return a report
- optionally return questions
- return best-effort token usage

The Settings page refreshes available models from the tools and uses a smoke prompt to confirm Claude, Codex and OpenCode are authenticated, not just installed. `claude-agent` has no paid health probe: its health check sends no prompt. It only loads the SDK, finds the Claude Code binary and runs `--version`. Authentication is decided per project when a task starts.

### The claude-agent tool

`claude-agent` is opt-in per role (or per task through `tools`). `defaultSettings().roles` does not change, so `claude-code` stays the default. Its model list is `default` (the built-in default: boof omits `model` and Claude Code chooses), `opus`, `sonnet` and `haiku`. Its cost is reported by the SDK and is an estimate (see [Budget Limits](#budget-limits)).

**Install.** The SDK exists only in the CLI/server install, where it is a normal npm dependency and is loaded lazily. The install pulls the SDK's platform binary (an optional dependency, about 322 to 337 MB) plus the SDK packages. `npm install --omit=optional` skips the binary. The binary is chosen in this order: the file named by `BOOF_RUNNER_CLAUDE_AGENT_BIN` (it must be executable, or the tool is unavailable), the SDK's platform binary, then the `claude` found on `PATH` (`BOOF_RUNNER_CLAUDE_BIN` names another command). The SDK is licensed under Anthropic's Commercial Terms and is not open source; see `THIRD_PARTY_NOTICES`.

**Not in the desktop app.** The desktop app does not offer `claude-agent`. The Agent SDK is under Anthropic's Commercial Terms (not open source) and its binary is about 330 MB, so the desktop installers neither bundle nor stage it, and the desktop process never loads it. The role editor and the project page show the tool as unavailable, and any task that would select it fails at selection with that reason. Use `claude-code` there.

**Authentication.** Anthropic allows the Agent SDK only with API-key authentication, so subscription (OAuth) accounts stay on the `claude-code` CLI. Each project chooses (`project.claudeAgent.auth`):

- `gateway` (the default): the step goes through the better-ccflare gateway from `settings.owlish`, but only when the compliance gate is open (see [Optional account pool](#optional-account-pool-better-ccflare)). The gateway needs two keys. The better-ccflare client key must be an **admin** key (with an api-only key the gate stays closed, HTTP 401), and boof uses it only for its own eligibility check. The child gets a separate api-only agent key, set write-only through `owlishAgentKey` (see below). Without an agent key the gateway is not usable for `claude-agent`: the project's own key is used when set (with a log note), otherwise the step is refused with "set an api-only better-ccflare agent key (Settings › Accounts) or a project API key".
- `project-key`: the project's own Anthropic API key. It is set write-only through `projects.update` (`anthropicApiKey`; `null` removes it) and stored only in `<data>/owlish/project-keys.json` (mode 0600). It never goes into settings, project.json, task files, events, audit, logs, error messages or process arguments, and no operation returns it. Only `sk-ant-api…` keys are accepted; OAuth tokens (`sk-ant-oat…`) and admin keys (`sk-ant-admin…`) are rejected with 400. The CLI takes the key only through `--input @file` or stdin, never as a flag and never in inline `--input` JSON (refused for any write-only field), so it does not appear in the process list.

When the project chose `gateway` and the gate is closed, the project's key is used if one is set, and the log says why. Otherwise the task does not start. A task whose roles (including a task-level `tools` override) use `claude-agent` is checked at selection: it fails before it starts, its log gets a `### Not started` block with the reason, and one `runner.agent_auth_refused` event is written. If the accounts change mid-run, the step fails the same way with an `ERROR:` log line and the same event. The reason is also in `runner.status.agentAuth` and in the Now lane of the Overview. Nothing is spent, the worktree is kept, and the task can be retried once the authentication is fixed.

**Gate order.** For each attempt of a step, in this order: the pool wait (gateway only), the budget check, a fresh authentication decision, the credentials, then the spawn. A retry or a steered rerun goes through the same order.

**Explicit credentials only.** Only the gateway (with the api-only agent key) or the project's stored key counts. The admin client key is never placed in the child's environment. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, Bedrock, Vertex and Foundry variables in the server's environment are not compliant authentication, and they are stripped from the child's environment before the chosen credential is added. The child gets only a short allowlist (shell basics, temp folders, `LC_*`, `XDG_*`, proxy and certificate variables), then `ANTHROPIC_API_KEY` (and `ANTHROPIC_BASE_URL` in gateway mode), `CLAUDE_AGENT_SDK_CLIENT_APP` and its own `CLAUDE_CONFIG_DIR`. `settings.runner.agentEnv` does not apply to `claude-agent`. In gateway mode the gateway host is added to `NO_PROXY` so a proxy in the environment cannot divert the request.

**Bare mode.** The tool runs Claude Code with `--bare` and `settingSources: []`. Claude Code then never reads OAuth, the Keychain or Anthropic profiles, and accepts only `ANTHROPIC_API_KEY` (gateway mode sends the api-only better-ccflare agent key in that variable). It receives only the `allow`, `deny` and `ask` permission rules from the repo's `.claude/settings.json` and `.claude/settings.local.json`. User-level permission rules from `~/.claude/settings.json` do not apply; this differs from `claude-code`, which honours them. Hooks, plugins and user settings do not apply either. Boof adds the repo's `CLAUDE.md` to the system prompt itself, capped at 64 KiB; a `CLAUDE.md` that is a symlink out of the worktree is ignored. Each project gets its own Claude config folder under the data root, `claude-agent-config/<project-id>`, so the user's `~/.claude` login and settings never apply.

**Exact key check.** The session's `system/init` message must report `apiKeySource` `ANTHROPIC_API_KEY`, in both modes. Any other value closes the query at once and fails the step with a non-transient error (`claude-agent refused: the session did not authenticate with the project's API key`).

**Known limit: the key is visible to the agent.** The agent can read the credential in its process environment, so it could write it into files or commits. In project-key mode that is the project's own Anthropic API key. In gateway mode it is the api-only agent key, which can only send model requests through better-ccflare; the agent never sees the admin client key, which stays inside boof, so it cannot change the pool through the admin API. Output redaction replaces the key in logs, streamed text and reports, but does not cover files. This is the same as `claude-code` with an API key. See [Agents are not sandboxed](#agents-are-not-sandboxed).

**Permissions.** With auto-approve the step runs with `bypassPermissions`; without it, every prompt is denied, as `--print` does for `claude-code`. The permission rules come only from the repo (see Bare mode). The step ends with the first result that answers the latest message sent to the session. Stop, timeout and stall close the query and kill the whole process group of the agent; timeouts and stalls are detected as for the other tools. The log header is `$ claude-agent (Agent SDK <version>) --model <m> [auth: ...]` and never contains a key.

## Runtime Controls

Boof Runner supports two runtime controls while a task is running.

### Stop

The UI can request a stop for the active task. The API writes a stop signal into the running task's control directory. The active child process polls for that signal and receives `SIGTERM`, followed by `SIGKILL` if it does not exit promptly.

The task is then recorded with the status `stopped` (directory `tasks/stopped/`), not `failed`: the user asked for it, nothing broke. The log gets a `### Stopped` block (`stopped by user`). Only the runner moves a task to `stopped`, and only from `running`. A stopped task can be retried (to `pending`) or archived.

A stopped run may have partial changes in its worktree. The worktree and branch are always kept (`worktree.onFailure: "delete"` never applies to a stop). A retry continues in that worktree: the pipeline tells the agent that the previous run was stopped and to inspect `git status` and `git diff` before it continues, like the "Previous attempt interrupted" note for transient retries.

A graceful shutdown (`SIGTERM`, for example under systemd) is intentional too: the engine asks each running task to stop and the task ends as `stopped` with the note `stopped by server shutdown`. A shutdown that begins while the engine is selecting work starts nothing more, and a task that still appears while the engine drains is asked to stop too. Only a crash (below) ends as `failed`. The desktop app does the same on quit: `before-quit` waits for `engine.shutdown` (grace `BOOF_RUNNER_SHUTDOWN_GRACE_MS`, default 30 s) before the process exits; a second quit request exits at once. A plan sync with `--stop-running` for a removed goal also ends the task as `stopped`. Older data roots have no `tasks/stopped/`; the runner creates it at start, and tasks that were stopped before stay `failed`.

### Recovery after a crash or restart

If the runner process dies hard (`SIGKILL`, out of memory, power loss, reboot), a task stays in `ongoing/` as `running`. When the runner starts, the process that holds the runner guard (`.runner.pid`) recovers every `running` task in every project before it selects work. It mirrors `log.txt` into the task body, appends an `### Interrupted` block, and moves the task to `failed` (event `task.status` with `by: "runner"` and a `reason`). The worktree and branch are kept, so retrying the task continues from them. A web process started with `--no-runner` never recovers tasks. Before a task is failed, the recovery reads `control/pid` (`{ pgid, command, startedAt, bootId, startTicks, ownerPid }`: the running step's process group, the boot id and the leader's start time that identify it, and the pid of the runner that spawned it; written by `execCommand` for the span of the child and removed when it closes): a group that still runs is killed (SIGTERM, then SIGKILL) and the Interrupted block says so. Reaping runs on Linux only (it needs `/proc` and the boot id). Elsewhere nothing is killed: if the recorded process is still alive the Interrupted block warns that the agent process (pid N) may still be running and should be stopped before Retry (macOS and Windows reaping is the goal `desktop-orphan-reaping-macos-windows`). A record is never acted on when its boot id differs from the current one or cannot be determined, when the pid is no longer a group leader with exactly the start time recorded (pid reuse, forged or older records), or while the recording runner is still alive and the leader's parent (a headless run). The startup log shows `Recovered N interrupted task(s): id, id`.

**Orphaned agents.** Each agent's process group (Windows: process) is recorded in the task's control directory with its boot identity and exact start time. On recovery boof kills a recorded agent only when the boot and the start time both match, so a reused pid is never signalled; a record that cannot be verified is never killed. Linux reads `/proc` (boot id, start ticks). macOS asks `sysctl -n kern.boottime` and `ps -o ppid=,lstart= -p <pid>` and kills the process group. Windows asks PowerShell `Get-CimInstance` (`wmic` as a fallback). It never uses `taskkill /T` (Windows does not reparent orphans and reuses pids, so `/T` could kill an unrelated app that still lists the pid as its parent): it reads the process table once; if that table is readable and does not show the agent with the recorded creation time, the agent is gone and nothing is killed (only an unreadable table falls back to `taskkill /F /PID` on the verified agent alone). Otherwise it stops the agent and only those descendants that were created after their parent, deepest first, from ONE PowerShell process that opens each process, compares its start time (UTC, cut to whole microseconds, since CIM has no 7th digit; the times travel as digit strings of ticks; Windows PowerShell 5.1 is the target) with the one from the table and only then kills it (an open handle keeps the pid from being reused; the script is fixed text and the pids and times travel as JSON on stdin). The runner's own process group or session is never signalled, and a probe that fails while the pid is alive counts as unknown, not gone. Deleting a task is refused, like Retry, while its recorded agent runs. The probes (`ps`, `sysctl`, PowerShell) run synchronously with a 5 s timeout when an agent starts and when Retry or Delete checks one; PowerShell can take 0.5 to 2 s a call, so on Windows an agent start or a Retry may pause the server that long (the boot time is cached per process). A Job Object (kill on close) at spawn is the long-term fix. **The macOS and Windows branches have been tested only against mocked command output and a mocked platform; no real Mac or Windows machine has run them.** Check them by hand: start a task with the mock tool that stalls, kill the app, relaunch, and confirm the agent is gone.

An agent that is still running when its task is recovered (it could not be killed, its runner still owns it, or it could not be verified) is remembered in the failed task's `agentProcess` (pid, command, boot, start time). **Retry, Unarchive and setting the status to `pending` answer `409 conflict` while that process still runs** (same boot, same start time); a process that is gone, or a different one under a reused pid, does not block, and the stored identity is cleared when the task is queued. The desktop app shows "Stopping running task... (quit again to force)" while a quit drains.

### Prompt Injection

The UI can inject an additional prompt while a task is running. Boof Runner writes that prompt to the running task's control directory and appends a note to the live log.

Stop and inject requests are written under the task's lock and only while the task is `running`: a request that loses the race with the end of the run answers 400 and, within one process, leaves nothing behind, and a run starts with an empty control directory.

The prompt has a mode:

- `next-step` (the default): the prompt is picked up before the next pipeline step and included in later prompts under a dedicated injected-prompts section. The step that is running is not touched.
- `now`: the same, and the runner also interrupts the running step. It writes a steer request (`control/steer`, one JSON line per prompt). For `claude-agent` the session is continued in place (below). For the other tools `exec` sees the request, kills the tool process group like a stop and reports `steered` (distinct from `stopped`). The pipeline removes the request, logs a `### Steered` block with the prompt and runs the same step again. The task is not stopped, no retry is used, and the usage of the interrupted attempt is still recorded.

A `now` prompt may also carry a `model` (`^[A-Za-z0-9._:\[\]\/-]{1,100}$`). It is accepted only with `mode: "now"`, otherwise 400 `model needs mode now`. The steer line carries it, the `## Injected` entry records `model=<m>` in its comment, and the rest of the step runs with that model (the last model given wins). For `claude-agent` the model is switched inside the running session; for the other tools it applies to the rerun. If the step ends before taking the steer, the text applies at the next step but its model switch is dropped. The model is sent as the inject `model` field. The UI's "Switch model" control is available only with "Now", and only for a running `claude-agent` or `claude-code` step.

How the step continues depends on the tool:

- A tool that supports session resume gets the same session back: Claude Code `--resume <session id>`, Codex `codex exec resume <thread id>`, OpenCode `run --session <id>`. The new message is "The user sent new instructions while you were working. Continue the same task from where you stopped and apply them:" followed by the prompt. The session id is read from the output of the interrupted attempt (stream-json `session_id`, `thread.started.thread_id`, `sessionID`).
- `claude-agent` steers in place. The runner interrupts the running turn through the SDK (`interrupt()`, 10 s limit) and sends the new instructions into the same open session, with the same "The user sent new instructions..." message. The process is not killed and the session keeps its memory. If the interrupt fails or times out, the runner kills the process and falls back to the kill-and-resume path above, and the steer file is taken from there. The step ends only with the result for the latest message, so the result of the interrupted turn never ends it.
- A steer applied in place continues the running session without a new auth check; any new process (fallback, retry or next step) goes through the full check again.
- A tool without resume, or an interrupted attempt that printed no session id, restarts the step: the original step prompt, the new instructions and the "Previous attempt interrupted" note that tells the agent to inspect `git status` and `git diff` and continue.

Limits of `now`:

- Resume depends on the tool CLI. A session that the CLI cannot find, or one that is cut before the tool saved it, ends the rerun with a tool failure like any other.
- The interrupted step may leave partial changes. A restarted step has to work from them; a resumed one has its own memory of them.
- It costs extra tokens: the interrupted attempt is paid for, and a restart re-reads the step prompt.
- `next-step` keeps its meaning for every tool, `claude-agent` included: it is read before the next pipeline step and is never sent into a running SDK session. Only `now` steers in place.
- A step takes at most 5 steers. Later `now` prompts then wait for the next step, as `next-step` prompts do.
- A steer that arrives between two steps kills nothing: the next step simply includes the prompt.
- A stop request that arrives with a steer wins.
- The request is picked up within about half a second.

Injected prompts are also kept in the task file, in the body section `## Injected`, written when the prompt is injected (the control directory is deleted when the task leaves `running`). Each entry is `### <ISO time> — <who>`, then a `<!-- boof: mode=now applied=<ISO time> -->` line (the inject mode, and when the prompt reached the agent: the next step started, or the steered step ran again; `applied` is added later), then the text; who is the API client name, or `user` for the local principal and the UI. Files without the section still parse. The section is append-only: saving a task never drops entries. The task Editor shows it in the "Injected" tab, and the task view of the API and MCP has `body.injected` (the raw section text).

When a task runs again (a retry of a stopped or failed task, or the next of several runs), the earlier injected prompts are not lost: the prompts of every step include them under `## Earlier injected instructions`, so the agent keeps following them. Prompts injected during the new run use the live mechanism above.

Verified live with Codex (codex-cli 0.164.0, model `gpt-6-luna`, 2026-11-02, a scratch data root and a throwaway repository): a task told to run `sleep 45` and then create `a.txt` was steered with `inject --mode now` ("also create b.txt ...") while the sleep ran, once in the planner step and once in the developer step. In both runs the log shows `### Steered`, then the step continues in the same thread (`codex exec resume <thread id>`: the Codex session file holds the original prompt and the steer, and two `task_started` turns): the agent says its wait was interrupted, restarts the sleep and creates both files. The reviewer approved. Both files were left uncommitted by the agent, so the runner committed them to the `<branch>--leftovers` branch, as it does for any uncommitted work. The log carries a few `ERROR codex_core::util: Custom tool call output is missing for call id ...` lines after a steer: Codex notes that the killed command never returned; they are harmless. `run --tool <tool>` without `--model` uses the tool's first listed model, then its built-in fallback, for tools that require a model (including Claude Code and OpenCode). For Codex it leaves the model empty so the Codex CLI uses its built-in default; Boof normally passes `--ignore-user-config`, so a `model` in `$CODEX_HOME/config.toml` is ignored. With `runner.inheritMcpServers` enabled, the config.toml model applies. The listing starts other tools' CLIs and may take up to 20 s; pass `--model` to skip it.

This gives the user a practical way to steer a long-running task between steps without changing the whole tool architecture.

## Architecture of the API layer

Everything a client can do is one **operation**, defined once with `defineOp()` in `packages/heart-server/src/api/ops/` (projects, plans, tasks, epics, admin, webhooks, whoami). An operation holds its name (`plans.sync`), scope(s), Zod input and output schemas, a REST mapping (method, path, status, `If-Match` field, ETag, idempotency), an optional MCP mapping (tool name and annotations) and a handler. The list is the **registry** (`registry.ts`). Four things are generated from it, so they cannot drift apart:

- **REST routes.** `packages/heart-server/src/server/rest.ts` mounts one Hono route per operation under `/api/v1` (and the deprecated unversioned `/api` copies). It maps path and query parameters, JSON bodies, `If-Match` and `Idempotency-Key` onto the input.
- **MCP tools.** `packages/heart-server/src/mcp/` serves every operation with `mcp.expose` as a tool (every JSON operation, 79 today; `tools/list` is filtered by the caller's scopes, `boof_<verb>_<noun>`), plus resources and two prompts.
- **CLI commands.** `packages/facedisk/cli/ops-cli.ts` turns each operation into `boof-runner <area> <verb>` (the words of the operation name in kebab-case: `plans.replaceGoals` is `plans replace-goals`) and runs it in-process with `op.execute`, as the local administrator or `--client <id>` (see the README, "Operation commands"). The parity test (`bin/src/parity.test.ts`) and the UI manifest (`packages/facedisk/ui/src/op-coverage.ts`, checked by `packages/heart-server/src/server/op-coverage.test.ts`) keep the surfaces complete: every operation is a REST route, an MCP tool (except attachment upload and download) and a CLI command, and the manifest records what the web UI does for each.
- **OpenAPI and the harness guide.** `buildOpenApi(registry)` produces the OpenAPI 3.1 document (`GET /api/v1/openapi.json`, committed as `packages/heart-server/openapi/openapi.json`). `scripts/gen-harness-reference.ts` turns it into the REST reference of `docs/harness.md` and writes `packages/heart-server/src/server/generated/harness.ts`, the copy the server embeds.

`Operation.execute` is the only way in. It checks the scope (an empty scope list, as in `auth.whoami`, means any authenticated caller), validates the input (`400 invalid_input` or `invalid_plan`), authorizes the project (`403 forbidden_project`), runs the handler, validates the output and maps every failure to an `OpError` with a stable code from `ERROR_CODES`. REST and MCP therefore share scopes, project restrictions, trust rules, validation and error codes.

### Request chain

For `/api/*` and `/mcp`: host guard (`421`), secure headers (HSTS only when boof terminates TLS, without `includeSubDomains`; the public docs are `Cross-Origin-Resource-Policy: cross-origin`), audit (outermost, so rejected calls are logged), body limit (`413`), an `Origin` check (`403 origin_not_allowed`: `Sec-Fetch-Site: cross-site` is refused outright, even on a GET; an Origin must equal the request `Host` with the scheme's default port filled in on both sides (`https://example.com` matches `Host: example.com:443`), or an `allowedHosts` entry (without a port: the default port only; with a port: that port); browsers send an Origin on every cross-origin request except no-cors GETs such as `<img>` and on every POST, so the check is safe only because no GET changes state: a future state-changing GET would not be covered), `authenticate` (a request whose key verifies is never limited by the unauthenticated limiter; a failed authentication takes a token from the per-client-address bucket and answers `429` instead of `401` when it is empty), rate limit (`429`, per principal), then the route. The public routes `GET /harness.md`, `/harness.txt` and `/llms.txt` are registered after the host guard and secure headers and before authentication: they hold no secrets and serve `docs/harness.md` as embedded text.

### Events and webhooks

Every status change and plan write appends one JSON line to `<project>/events.jsonl` (runner toggles and `runner.budget_exceeded` to `<data>/events.jsonl`; files rotate monthly). `GET /api/v1/events` streams them as server-sent events with opaque cursors, replayable with `since` or `Last-Event-ID`, plus unnumbered `changed` hints from the file watcher. Each stream re-resolves its principal on every drain (watcher broadcast or the 2 s poll) and ends with `event: unauthorized` when the key no longer authenticates (about 7 s at most for a revocation made in another process: the 5 s client cache plus the poll); open streams are capped at 16 per principal. `WebhookDispatcher` (web process only) delivers the same events to `settings.webhooks` with an HMAC-SHA256 signature (secret from `webhooks/secrets.json`, 0600), retries and a dead-letter directory. See [api.md](api.md).

### MCP

Audit lines for stdio MCP and the generated CLI are written by `auditOperation` in Heart core (`packages/heart/src/audit-log.ts`, the same writer as the web middleware, the same `security.audit` settings): one line per tool call or operation run with `principal`, `kind`, `action` (`mcp:<tool>`, `cli:<operation>`), `via`, `project`, `outcome` (`error` carries the error code) and `ms`, never arguments, prompts or keys, and never a project id that is not kebab-case; a failed write is logged to stderr and never fails the operation. A refused identity (CLI exit 3) and usage errors run no operation and write no line. The hand-written commands are audited directly (next paragraph). `boof-runner mcp` serves stdio (`--client` picks an API client, `--project` fixes the project and narrows the principal to it; without `--client` the host acts like a review-trust client, as the reserved principal `local-mcp`, unless `--admin` makes it the local administrator); `POST /mcp` serves Streamable HTTP in stateless mode (a fresh server per request, JSON responses, no sessions). The principal comes from the same authenticator as REST, so revocations apply at once; a keyless loopback request under `local-trust` is not the administrator but the review-trust `local-mcp` principal with the administration tools hidden, as on stdio (set before the rate limiter, so it has its own bucket and the audit line names `local-mcp`; it is refused with `403 forbidden_trust` while `auth/clients.json` holds a stored client of that reserved id, as stdio refuses to start, and `serve` warns about it). A tool call runs `op.execute` and is audited as `mcp:<tool>`.

The hand-written commands are not routed through an operation. None of them has the same behaviour as one operation and the same output: `run` and `scan` drive the local runner, `project add` can initialise a repository and the default project, `plan import` merges and approves as the local owner, `remote setup` edits settings and creates a client together, and `service` writes a systemd unit. There is no operation for `run`, `scan`, `remote` or `service`. Each writing command calls `auditOperation` once, with `via: "cli"`, action `cli:<command>`, the local administrator as principal, the project when the command targets one, the outcome and `ms`. The action names are `cli:run`, `cli:scan`, `cli:project.add`, `cli:project.remove`, `cli:epic.add`, `cli:epic.archive` (`--undo` is the same command), `cli:epic.remove`, `cli:task.move`, `cli:plan.import`, `cli:plan.sync`, `cli:auth.add`, `cli:auth.revoke`, `cli:auth.rotate`, `cli:remote.setup`, `cli:remote.disable`, `cli:service.install` and `cli:service.uninstall`. A missing flag, `--help` or an unknown subcommand writes no line. An unknown `--project` on `run`, `scan`, `epic`, `task` and `plan` writes one error line (`project_resolution`, or `invalid_id` when the id is not kebab-case), as the generated CLI writes a line for an unknown project. The `project` field is set only for a kebab-case id, so a rejected value is left out. A refusal whose data root does not already exist writes no line and creates no directory. `scan --dry-run`, a `scan` that finds no units, and `plan sync --dry-run` write nothing. `project list`, `epic list`, `task list`, `plan export`, `auth list`, `remote status`, `service status` and `service logs` write no line. `serve` and `mcp` are audited per request or tool call. `service install` records the line in the data root the unit will use; a preflight refusal writes one only when that directory already exists. `service uninstall` records the line in the data root stored in the unit (its options line, or the legacy ExecStart `-d`), and only when that directory already exists. It never falls back to `$PWD/data`. The message is `Removed boof-runner.service. Task data was not removed.` An interrupted `run` writes one line with error `interrupted`. `auth add` records success once the client exists.

## Web API And UI

The REST surface is the registry (see above); the full list with inputs, outputs, scopes and errors is the generated reference in [harness.md](harness.md) and the OpenAPI document. In short:

- projects: list, create, get, update, archive, unarchive, pause, resume, delete (`?purge=true` removes the data and is refused with `409 project_busy` while a task runs), usage
- epics: `/api/v1/projects/{p}/epics…` (list, get, create, update with `PUT` and `If-Match`, delete with `?detach=true`); a task joins an epic with `epicId` on create or `tasks.move`, and a subtask with `parentId`
- per-project tasks under `/api/v1/projects/{p}/tasks…`: CRUD, reorder, skip, retry, archive, unarchive, delete, queue, answers for parked tasks, attachments, live log, wait (long poll; stops when the client disconnects), stop and prompt injection (modes `next-step` and `now`)
- per-project plans under `/api/v1/projects/{p}/plans…`: list, create, get, update, replace goals, upsert and remove a goal, reorder, goal status, repo import, XML export, sync (`dryRun`). Writes honour `If-Match: "<version>"` or `expectedVersion`
- `GET /api/v1/actions`, `GET /api/v1/whoami`, runner status and toggle, command templates (writes: `settings:write`), settings, tool health and models (`GET /health` and `GET /models` only report the last probe of this server process; `POST /health/check` and `POST /models/refresh` run the tools), token usage, API clients (`auth:admin`) and webhooks (`admin`)

The unversioned routes (`/api/projects/…`, and `/api/tasks…` as aliases of `settings.defaultProject`) still work but answer `Deprecation: true` and `Sunset`. They keep their old shapes. New code uses `/api/v1`.

Requests need a loopback `Host` header (`localhost`, `127.0.0.1`, `[::1]`) or a name in `security.allowedHosts`; others get `421`. Errors have the shape `{ "error": { "code": "…", "message": "…", "details"?: … } }`. Status changes through the API are limited to `draft`, `pending` and `archived`; the runner owns `running`, `action`, `done` and `failed`.

The React UI consumes that API and listens to the event stream. SSE `changed` hints come from a file watcher over `projects/` (depth 6), `commands/` and `settings.json`; each carries `{ "project": "<id>" }` when the path is under a project. After an event, the UI reloads current state from the filesystem-backed API.

Important UI areas:

- Tasks: queue, priority, status filters, proposed-by-clients filter, running task live panel
- Editor: task prompt, labels, runs, command template, attachments, reports, logs
- Plans: goals with dependencies, approve, sync preview, auto-sync
- Actions: parked planner questions awaiting user answers
- Commands: reusable instruction templates
- Settings: concurrency, default project, tool health, model lists, roles, review, worktree, retries, budget, usage, API clients, per-project overrides

## API Authentication

Authentication is middleware in `packages/heart-server/src/server/middleware/`. The operations declare their scope in the registry, `execute` enforces it, and `authorizeProject()` runs before any project access.

- Principals: `local` (loopback peer, no `Authorization` header, no `X-Forwarded-For`, `security.auth.mode = "local-trust"`; all scopes, `trusted`) or a client holding a key `boof_<clientId>_<base64url(32 bytes)>`. Only `sha256(secret)` is stored, in `<data>/auth/clients.json` (mode 0600), compared with `timingSafeEqual`. A JSON body without `Content-Type: application/json` is `415 unsupported_media_type`; with the `Origin` check this is the CSRF defence for the local principal (the Host guard only blocks DNS rebinding).
- Scopes: `projects:read|write`, `plans:read|write`, `tasks:read|write|control` (stop, inject), `settings:read|write`, `runner:control`, `auth:admin`, `admin` (everything). Pause and resume accept `runner:control` or `projects:write`; toggling the runner accepts `runner:control` or `settings:write`; usage accepts `projects:read` or `tasks:read`. `auth.whoami` needs no scope.
- Project restriction: a client may be limited to a list of projects; other projects answer `403 forbidden_project` (so existence is not probed) and list routes filter. A non-local principal registering a project (or moving its working directory) must pass `security.allowedProjectRoots`, the git and data-root checks and the `/`/home exclusion, else `403 project_root_not_allowed`. The desktop app's own key (`desktop-ui`), used from loopback without proxy headers, registers projects under the local principal's rules.
- Trust: `review` clients (the default) create tasks and plans as `draft` (tasks get the label `external:<id>` and an `origin`), and cannot queue, retry, unarchive, answer, activate a plan, edit an active plan, or stop, inject into, move, edit (rename included) or delete a task it did not create, or detach subtasks: `403 forbidden_trust`. It may create subtasks under any task (they stay drafts) and create epics, update only epics it created (an epic records its creator in `origin`; one without `origin` is a human's), and never delete an epic. A review-trust client edits the title and goals only of a plan it created (never a human's, draft or archived), and cannot create, archive, unarchive or purge a project, may change only the `name`, `labels` and `paused` of one (every other field, such as `brief`, `defaultBase`, `workingDirectory`, `archived`, `roles` and `budget`, is `403 forbidden_trust`), cannot switch the runner, and cannot change the title, prompt, command or run count of a task that is not a draft, and adds or removes attachments only on its own drafts (the prompt tells the agent to read every attachment). It deletes only the webhooks it created. A project-restricted key cannot switch the runner (`PUT /runner`, `boof_set_runner`: `403 forbidden_project`; it can pause its own projects). Plan content edits by a review client on a draft or archived plan it created are accepted: nothing runs until a human activates the plan, which approves the content as it then is. `security.externalTasksRequireApproval = false` lifts this. `trusted` clients behave like local.
- Admin API (`auth:admin`): list, create, revoke and rotate clients. Responses never contain `keyHash`; a caller cannot grant scopes, trust, projects or a later expiry than it holds (a restricted caller's projects and expiry are inherited when omitted). A client created through the API always gets a random suffix (`name-1a2b3c`), whether or not the name is taken, so creating one reveals nothing about clients the caller cannot see; the id `local` is reserved. A webhook made before the creator flag existed is checked at delivery when its `createdBy` is a client id. Rotate and revoke answer a client with more reach than the caller (and an unknown id) with the same `404`, and list shows only the clients the caller may manage plus itself. Delivery re-checks the creator too: a webhook an API client created is not delivered once that client is revoked or expired or no longer covers the webhook's projects (a webhook made by the local principal is unaffected). The same reach rule covers webhooks (admin): a project-restricted key creates webhooks limited to its own projects (the default; a wider list is `403 forbidden_project`), and lists and deletes only webhooks that reach its projects alone (others answer `404`). `PUT /settings`, like command templates, needs a trusted client without a project restriction (`403 forbidden_trust`). A review-trust client sets back to draft only a plan it created, whether the plan is active or archived.
- Settings (`settings.security`, edited in `settings.json`, not through `PUT /settings`): `allowedHosts`, `trustedProxies` (default `["loopback"]`), `auth.mode`, `allowedPrivateWebhookHosts`, `allowedProjectRoots`, `externalTasksRequireApproval`, `rateLimit`, `audit`. `settings.mcp.enabled` switches MCP off. `GET /healthz` caches `runner.enabled` for 5 s; `running` and `uptimeSeconds` are live. The desktop app's embedded server reports `version` from the app and `runner.running` from the engine loop.
- Binding: `--host`/`BOOF_RUNNER_HOST`; a non-loopback bind needs `auth.mode = "required"` and an active client; the bind host is added to the Host allow-list. `--tls-cert`/`--tls-key` serve HTTPS.

## Persistence And Safety

The most important safety mechanisms are:

- Atomic writes: files are written through a temp file that is fsynced, then renamed, and the directory is fsynced after it, so a crash leaves the old or the new file, never a partial one. Creating a task is exclusive: it fails with a conflict if the id exists.
- Locks (within one process): `TaskStore` serializes every operation on one task id (create, save, modify, transition, delete), so a claim and an edit cannot interleave. Settings, project and auth read-modify-write cycles (`SettingsStore.mutate`, the project and auth stores) each run under one lock, and a plan sync runs under a per-plan lock. A writer that owns only some fields uses `TaskStore.modify` and keeps the edits made since it loaded its copy.
- API client registry across processes: every write to `auth/clients.json` (create, revoke, rotate and the `lastUsedAt` touch) runs under `auth/.clients.lock`, a pid lock shared by the CLI, the server and the desktop (a lock left by a dead process is taken over; a live holder is waited for up to 30 s, then the call fails with "Another boof process is updating the API clients"). So `auth revoke` on the command line is never undone by the server's concurrent `lastUsedAt` write.
- Task lock across processes: every task write (`save`, `modify`, `transition`, `appendInjected`, delete and the other locked operations) runs under `<project>/tasks/.locks/<id>.lock`, a pid lock (the same mechanism as the API client registry, the project create lock and the migration lock). The file holds `<pid> <boot id>`; a boot id is the per-boot uuid (`/proc/sys/kernel/random/boot_id` on Linux, `sysctl -n kern.bootsessionuuid` on macOS), and without one (Windows, a sandbox with `/proc` masked) the file holds the pid alone. A lock is stale, and the next operation takes it over, when its pid is dead, when both it and this process name a boot id and the two differ (after a reboot the pid may belong to another process; a process without a boot id never overrides a live pid, so a lock left by a crash plus a reboot with a reused pid is then removed by hand), or when it is empty and 30 s old (a crash or power loss before it was written). Do not run an older boof and a newer one on one data root: an older binary does not read the boot id and will not take over a stale lock of the new format whose pid is alive. A live holder is waited for up to 30 s, then the call fails with "Task <id> is being changed by another boof process" and the lock path, to remove if no boof process runs. The CLI, MCP stdio and the server's runner therefore cannot lose each other's task writes or recreate a file in a status directory the task has left. The lock file is created (not fsynced) and removed per operation, outside the status directories; it costs about 1 ms per locked operation on a local disk, on top of the write itself (a few ms with its fsync). A first sync of a large plan (hundreds of new tasks) or a template rename across many tasks still takes seconds, because each task is its own locked, fsynced write.
- Status state machine: illegal task transitions are rejected.
- Hierarchy caveats: the hierarchy lock (`<project>/.locks/hierarchy.lock`) and the `epics.json` lock (`<project>/.locks/epics.lock`) are pid locks like the task lock, so the hierarchy operations (`epic add`, `epic remove`, `task move`, creating or deleting a task with an epic or parent) are serialised between processes: a CLI command racing the server cannot lose a write or leave a task naming an epic or parent that one of them just removed. Plan sync is not one of them: it sets a goal's `epicId` on the tasks it creates or moves without the hierarchy lock and without checking that the epic exists, so a plan goal's epic can still dangle (a task naming an epic that was removed or never existed) and is flagged `epicMissing`. `epic remove --detach` clears the epic of its tasks 100 at a time and lets other hierarchy operations in between, so even a huge epic does not hold the lock past the 30 s other processes wait for it. Lock order, outermost first: hierarchy, task, epics; nothing that holds a task or epics lock takes the hierarchy lock. A reference to an epic or parent that is gone (a hand-edited file) still loads fine and is flagged (`epicMissing`, `parentMissing`). A boof version from before the hierarchy drops `epicId` and `parentId` when it rewrites a task file, so do not run an old and a new version on one data root. A new revision of a plan goal whose last task is done starts a follow-up task that takes only the goal's `epicId`; the plan XML export does not carry a goal's `epicId`. An epic's progress counts drafts.
- Directory reconciliation: status directories repair mismatched task frontmatter.
- One webhook dispatcher per data root: a server delivers webhooks only while it holds the pid lock `<root>/webhooks/.dispatcher.lock`. On shutdown the holder waits for the delivery pass in progress before it releases the lock, so a graceful handover does not overlap. A second `serve` on the same root retries every 5 s and takes over when the first exits or dies (a stale lock is taken over at once; the delivery cursors in `webhooks/state.json` carry on), so each event is delivered once, apart from a crash mid-delivery: delivery is at least once, and the delivery id (`X-Boof-Delivery`) is a hash of the webhook and the event, the same for every copy, so a receiver can drop repeats. It is independent of the runner guard: a lone `--no-runner` server still delivers. Headless `run` and `scan` do not deliver.
- Single-runner guard: the CLI prevents duplicate runner loops for the same data root. `<root>/.runner.pid` is a pid lock held for the life of the runner: it is created exclusively (two processes starting together cannot both get it) and holds `<pid> <boot id> <start time> <pid namespace>` (each where the system has it, as for the other pid locks; the start time and the namespace only on Linux). The next start takes over a file left by a crash, including one whose pid was reused after a reboot (another boot id) or inside one boot (another start time); an old pid-only file is judged by its pid alone, and a clean shutdown removes the file. A second `serve` on a data root whose runner is alive still serves the web UI but does not start a second runner. A pid and its start time mean something only inside the pid namespace the lock records: a holder from another pid namespace (a container that shares the data root with the host) is waited for, never taken over by guessing from its pid, so sharing a data root across pid namespaces is not supported. Only a different boot id overrides that. Mixed versions on one data root are not supported either: an older binary reads the new file as no runner, overwrites it and starts a second runner. The desktop app (its own data root) and the headless `run` and `scan` commands start their engines without this guard, by design; they claim tasks under the task lock, so a double claim fails cleanly.
- Across processes (the CLI next to the server) the in-process locks do not apply. The API client registry, the task, hierarchy and epics locks, the project create lock and `<root>/.migration.lock` are pid locks and hold; otherwise only whole-file atomic writes and exclusive task create do, so two processes that edit the same settings or plan at once can lose one update. Data roots shared across hosts are not supported: the migration lock names a pid, which means nothing on another machine.
- Worktree isolation: code mutation happens away from the main checkout where possible.
- Durable logs and reports: live output is mirrored back into the task file before final status transitions.
- Mock tool tests: most behavior is tested without network access or token spend.

## Important Tradeoffs

Boof Runner deliberately keeps the first version local, single-user, and file-backed. That makes it easy to inspect and recover data, but it also means:

- There is no multi-user permission model.
- There is no remote queue or hosted control plane.
- The runner runs at most one task per project at a time (`runner.concurrency` allows tasks of different projects to overlap).
- Stop is best-effort and process-level, not a semantic rollback.
- A prompt injected with mode `next-step` is applied between tool runs. Mode `now` interrupts the running step and resumes the tool session (or restarts the step); it is not a live message into the running process.
- Budgets are enforced between steps, never mid-step: a step is not killed for cost, so the last step of a run can overshoot its limit (see Budget limits above).

These tradeoffs are acceptable for a local code-execution runner, but they should be revisited if Boof Runner becomes a multi-user or remote system.

## Suggestions

The highest-value next improvements are:

1. Add a worktree review screen

   The reviewer sees the diff, but users would benefit from a UI view that shows the actual branch/worktree diff before retrying, archiving, or accepting a result.

2. Support interactive tool sessions when available

   Inject mode `now` interrupts the step and resumes the tool session. True mid-run injection without the interruption would require interactive sessions or a tool-specific control protocol. If Claude Code or Codex expose stable session APIs, Boof Runner should add adapters that can send input into an active session.

3. Mid-step budget enforcement — A step is never interrupted for cost. If the agent CLIs expose a cost boundary during a run, the budget check could move inside a step.

4. Improve stop cleanup policy

   A stopped task keeps its partially modified worktree and branch today. Making this policy configurable (keep or discard) and adding UI choices such as retry from current state are follow-ups.

5. Expand model metadata

   The settings page currently shows model names. It could also show model source, availability, default role fit, and whether a health probe succeeded for that model.

6. Push notifications to MCP clients

   Events exist (replayable SSE and signed webhooks), but the stateless MCP endpoint cannot push them. A stateful transport with resource subscriptions would let agent hosts react without polling `boof_wait_task`.

7. Raise concurrency within one project safely

   Different projects already run side by side (`runner.concurrency`). Running two tasks of one repository needs race-safe worktree and branch creation first, plus explicit resource limits.

## Summary

Boof Runner is the execution engine of the boof project. It takes local task files, runs coding-agent tools through a fixed planner/developer/reviewer pipeline, isolates code changes in git worktrees, exposes progress through a local web UI, and records durable results back to plain markdown.

Its core strength is controlled local automation: users can queue work, watch it run, intervene when needed, and keep the full history on disk.
