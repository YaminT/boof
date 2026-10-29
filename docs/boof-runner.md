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

In this repository, Boof Runner includes:

- `packages/runner`: the execution engine, pipeline, tool adapters, worktree handling, usage tracking, and process execution.
- `packages/shared`: the task file format, schemas, lifecycle state machine, settings, paths, attachment storage, and atomic file writes.
- `packages/api`: the operations registry (`defineOp`), the services over the stores (`TaskService`, `ProjectService`, `PlanService`), the error table and the OpenAPI generator.
- `packages/mcp`: the MCP server (stdio and Streamable HTTP), generated from the registry.
- `packages/web`: the Hono server: the security middleware chain, the REST routes generated from the registry, the event stream, webhook delivery, the `/mcp` mount and the public agent docs.
- `packages/web/ui`: the React UI for task management, settings, live logs, actions, and runtime controls.
- `packages/desktop`: the Electron wrapper that runs the same server, runner, and UI in a native window.
- `bin`: the `boof-runner` command that scaffolds the data root, starts the web server, and ensures only one runner is active.

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
webhooks/
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

Creating a project (`ProjectStore.create`) resolves the realpath, requires a git work tree (the check is injected by the caller, so `shared` does not depend on `runner`), refuses a directory inside the data root or one that is already a project, and derives the id from the directory name. A project with an empty `workingDirectory` can only come from migrating a v1 data root that never had one; the runner skips it until a directory is set.

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
- `steps` (optional): the current run's pipeline step headers, each `{ label, at }`, in order; reset when the task enters `running`
- per-task tool overrides
- token usage
- timestamps

The body stores human-readable content:

- original prompt
- injected command text
- planner questions
- user answers
- planner/developer/observer/reviewer reports (observer and reviewer sections hold one entry per round, with its verdict)
- raw execution log

A line inside a section that would start another section (`## Log`, `### Reviewer`, ...) is stored indented by one space; only the first occurrence of each heading opens a section.

This format keeps task data editable, inspectable, and portable outside the app.

## Plans

A plan is an ordered DAG of goals for one project, stored as `projects/<id>/plans/<planId>.json`. A goal has an id, title, optional repo-relative `path`, `order`, `dependsOn`, `status` (`plan|develop|review|done`), an optional `model` hint, a `spec` (goal, stack, do/don't rules, tests) and a `history` of status entries. The spec maps one to one onto a boof-planner `goal.boof.xml`.

Plan fields: `status` (`draft`: never synced; `active`: syncable; `archived`), `autoSync` (the engine syncs the plan at the start of each tick and before it starts tasks), `bumpTo` (`review` or `done`: the status recorded when a task finishes), `source` (`ui|api|mcp|repo-import`, plus the creating client) and `version`.

Validation (`validatePlan`): unique goal ids, dependencies that exist, no cycles, and an `order` consistent with the dependencies. Writes renumber `order` 1..n along the topological order that is closest to the given one. A goal path must be relative and may not contain `..`.

Each goal has a `revision`. It goes up by one whenever the spec, `dependsOn` or `model` changes (title, path and order do not count). `PlanStore` keeps `version` optimistic: `save` needs the version that is stored right now or throws `PlanVersionConflict`. The API maps that to `409 plan_version_conflict`.

### Sync

`plan sync` / `POST …/plans/:planId/sync` works on `active` plans and is idempotent. Goals are walked in order. A goal that is not `done` and whose dependencies are all `done` gets a task if no task exists for its current revision: title `boof: <goal title>`, labels `plan:<planId>`, `goal:<goalId>` (plus `boof-scan` and `boof-status:<status>` for imported plans), priority `(open goals − position) × 10`, `planRef {planId, goalId, revision}`, `promptSource: plan`, `base` = the project's default base, status `pending`. The prompt is the unit prompt (goal, stack, rules, tests, TDD, do not edit the plan files) plus a `## Plan` section. Tasks start in `draft` when the plan was created by a `review`-trust client and `security.externalTasksRequireApproval` is on (and for any sync a `review`-trust client triggers).

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

The runner polls `tasks/pending/` of every active, non-paused project that has a working directory and chooses across all of them: highest `priority`, then oldest `updated`, then project id (then task id) so the order is deterministic. It transitions the chosen task to `projects/<id>/tasks/ongoing/<task-id>/` and builds the pipeline with the project's effective settings.

### Concurrency

`settings.runner.concurrency` (default 1) is the number of tasks in flight. The invariant is **at most one running task per project**: the engine keeps a map of in-flight pipelines by project id and `selectNext()` skips those projects, because worktree creation, the `.meta` sidecar and branch creation in one repository are not race-safe. With concurrency 2 two projects can run side by side; two tasks of one project never do. Concurrent agent CLIs share CPU, memory and API rate limits. The mock tool's `mockState` is module-global, so tests that run tasks concurrently track their own state in the `onRun` hook instead of relying on `mockState.prompts` or `calls`.

For each task, the pipeline runs these steps:

1. Planner
   Creates an implementation plan. If it cannot proceed without user input, the task is parked in `actions/`.

2. Planner refinement
   Reads the first plan and produces a refined final plan.

3. Developer
   Implements the plan in the working directory or isolated worktree.

4. Observer (optional)
   A second model checks the task prompt, the final plan and the diff against the worktree base, and ends its report with a verdict.

5. Reviewer
   Gives the final review of the diff and ends its report with a verdict.

Developer, observer or reviewer questions are routed back to the planner internally. Only planner questions that block the original task are surfaced to the user.

### Observer Role

The observer is configured with `settings.roles.observer` (`{ "tool", "model" }`) or per task with `tools.observer` in the frontmatter; the per-task value wins. When neither is set there is no observer step. The Settings page shows the assignment and offers `(none)` to unset it. Task files without an `### Observer` report section still parse.

### Verdict Protocol

The observer and reviewer system prompts also tell the agent to experiment in a temporary directory outside the working directory and to leave the working tree exactly as found (revert edits to tracked files, delete anything it created), so the leftover auto-commit never sweeps scratch files into the branch.

The observer and reviewer system prompts require the report to end with exactly one line:

- `VERDICT: APPROVE`
- `VERDICT: CHANGES_REQUESTED`, with the findings listed above it
- `VERDICT: REJECT`, for work that should not be fixed in place

`parseVerdict(report)` (in `@boof-runner/shared`) is strict and case-sensitive; it ignores trailing whitespace and markdown emphasis characters (`*`, `_`, backticks) around a line. The last non-empty line must match `^VERDICT:\s*(APPROVE|CHANGES_REQUESTED|REJECT)\s*$`. Any other exact verdict line anywhere in the report with a different verdict makes the result INVALID, even across blank lines; identical repeated verdict lines are fine. It fails closed: a missing verdict, a malformed one, text after the verdict line, or conflicting verdict lines all mean not approved.

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
- `review.maxInlineDiffBytes`: largest diff inlined in observer, reviewer and developer-fix prompts (default `120000`). Over the limit, the prompt carries the `--stat` summary, the untracked-file list and a note giving the base sha and telling the agent to run `git diff <base>` (per file `git diff <base> -- <path>`). The log records `Diff exceeds inline limit`.

### Mock Verdicts

The mock tool emits scripted verdicts for offline tests. Put a marker in the task prompt: `[[mock-verdicts observer=CHANGES_REQUESTED,APPROVE reviewer=APPROVE]]`. Each role takes one token per round and the last token repeats. Tokens: `APPROVE`, `CHANGES_REQUESTED`, `REJECT`, `NONE` (no verdict line), `GARBLED` (`VERDICT: MAYBE`), `CONFLICT` (two disagreeing final lines). The marker must sit on one line, the last complete marker in the prompt wins, and unknown tokens throw. Without a marker, the mock observer and reviewer approve.

When a task has `runs > 1`, Boof Runner re-queues it after each completed run until `completedRuns` reaches `runs`. Later runs include framing that asks the agent to critically review and improve the previous run's work.

## Code Execution And Isolation

When the project's `workingDirectory` is a git repository, Boof Runner creates a dedicated git worktree for a running task. Agent tools execute inside that worktree, not directly in the main checkout.

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

- The choke point is `Pipeline.runStep`. After a tool step returns, its cost is added to the run total and to the daily ledgers (`recordSpend` in `packages/shared/src/budget.ts`: `<data>/usage/daily/<date>.json` for everything, `<project>/usage/daily/<date>.json` for one project; atomic writes under the per-path lock; the date is the day in `budget.timezone`). Before the next step starts, `assertBudget` compares the run total with `perTaskUsd` and evaluates the day scopes that apply (`global`, `project:<id>`, `tool:<t>`, `project:<id>/tool:<t>`); a spent scope throws `BudgetExceededError` (`budget exceeded: <scope> <spent>/<limit> USD`) and the task fails through the normal failure path. A step is never killed for budget, because a CLI step cannot be interrupted at a cost boundary; the last step of a run can overshoot, and its cost is recorded without failing the run. A `ToolRunError` carries the usage of the failed attempt (transient, steered or final); it is recorded like a result.
- Selection (`RunnerEngine.selectWithBudget`) skips projects and tasks (by the tools of all four roles) whose day scope is spent and reports them. When nothing can start and something was skipped, `tick()` returns `{ kind: "budget", scopes }` and `runUntilIdle()` ends with that result instead of `idle`. `runner.budget_exceeded` is appended to `<data>/events.jsonl` once per day and scope (the marker is the `notified` list in the global ledger, so a restart does not repeat it); project scopes carry `project`.
- `onExceed: "pause"` keeps the worktree and branch whatever `worktree.onFailure` says; `"fail"` follows it. Both fail the task; a day budget that is spent blocks new work in its scope until midnight (in the budget zone) for both.
- Usage with `known: false` counts as 0 and increments `unknownSteps`; a tool without cost reporting is therefore unlimited. Codex reports token counts but no price, so its steps are unknown and `perToolDayUsd` cannot limit it; ledgers written before this change keep what they recorded.
- Spent means `spent >= limit`. Per-task cost counts the current pipeline run only.
- Read side: `evaluateBudget` (shared) powers `GET /api/v1/usage/budget`, the `budgetExceeded` list in `runner.status` and `runner.overview`, and the UI.
- The mock tool takes `[[mock-cost 0.5]]` (every step costs $0.50) or `[[mock-cost unknown]]` (no usage reported); the default is $0.01.

## Non-Interactive Guard

Every role's system prompt (planner, refinement, developer, observer, reviewer, planner-answering) ends with a guard: the tool runs non-interactively, its process exits when the turn ends and kills anything in the background, so the agent must never end its turn while waiting on background work. Commands longer than about 10 minutes run in the background with an exit-status marker file and are awaited with repeated foreground loops under 10 minutes.

## Findings Across Iterations

With `runs > 1`, from iteration 2 on, every step's prompt gains `## Findings from the previous iteration`: the final observer report (if any) and final reviewer report of the previous iteration, verdict lines included.

## Tool Adapters

Tools are behind a shared `Tool` interface. The pipeline does not know how Claude Code, Codex or OpenCode are invoked; it only calls the registered tool.

Built-in tools:

- `claude-code`: runs the `claude` CLI in non-interactive mode.
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

The Settings page refreshes available models from the tools and uses a smoke prompt to confirm Claude, Codex and OpenCode are authenticated, not just installed.

## Runtime Controls

Boof Runner supports two runtime controls while a task is running.

### Stop

The UI can request a stop for the active task. The API writes a stop signal into the running task's control directory. The active child process polls for that signal and receives `SIGTERM`, followed by `SIGKILL` if it does not exit promptly.

The task is then recorded with the status `stopped` (directory `tasks/stopped/`), not `failed`: the user asked for it, nothing broke. The log gets a `### Stopped` block (`stopped by user`). Only the runner moves a task to `stopped`, and only from `running`. A stopped task can be retried (to `pending`) or archived.

A stopped run may have partial changes in its worktree. The worktree and branch are always kept (`worktree.onFailure: "delete"` never applies to a stop). A retry continues in that worktree: the pipeline tells the agent that the previous run was stopped and to inspect `git status` and `git diff` before it continues, like the "Previous attempt interrupted" note for transient retries.

A graceful shutdown (`SIGTERM`, for example under systemd) is intentional too: the engine asks each running task to stop and the task ends as `stopped` with the note `stopped by server shutdown`. A shutdown that begins while the engine is selecting work starts nothing more, and a task that still appears while the engine drains is asked to stop too. Only a crash (below) ends as `failed`. A plan sync with `--stop-running` for a removed goal also ends the task as `stopped`. Older data roots have no `tasks/stopped/`; the runner creates it at start, and tasks that were stopped before stay `failed`.

### Recovery after a crash or restart

If the runner process dies hard (`SIGKILL`, out of memory, power loss, reboot), a task stays in `ongoing/` as `running`. When the runner starts, the process that holds the runner guard (`.runner.pid`) recovers every `running` task in every project before it selects work. It mirrors `log.txt` into the task body, appends an `### Interrupted` block, and moves the task to `failed` (event `task.status` with `by: "runner"` and a `reason`). The worktree and branch are kept, so retrying the task continues from them. A web process started with `--no-runner` never recovers tasks. The startup log shows `Recovered N interrupted task(s): id, id`.

### Prompt Injection

The UI can inject an additional prompt while a task is running. Boof Runner writes that prompt to the running task's control directory and appends a note to the live log.

The prompt has a mode:

- `next-step` (the default): the prompt is picked up before the next pipeline step and included in later prompts under a dedicated injected-prompts section. The step that is running is not touched.
- `now`: the same, and the runner also interrupts the running step. It writes a steer request (`control/steer`, one JSON line per prompt); `exec` sees it, kills the tool process group like a stop and reports `steered` (distinct from `stopped`). The pipeline removes the request, logs a `### Steered` block with the prompt and runs the same step again. The task is not stopped, no retry is used, and the usage of the interrupted attempt is still recorded.

How the step continues depends on the tool:

- A tool that supports session resume gets the same session back: Claude Code `--resume <session id>`, Codex `codex exec resume <thread id>`, OpenCode `run --session <id>`. The new message is "The user sent new instructions while you were working. Continue the same task from where you stopped and apply them:" followed by the prompt. The session id is read from the output of the interrupted attempt (stream-json `session_id`, `thread.started.thread_id`, `sessionID`).
- A tool without resume, or an interrupted attempt that printed no session id, restarts the step: the original step prompt, the new instructions and the "Previous attempt interrupted" note that tells the agent to inspect `git status` and `git diff` and continue.

Limits of `now`:

- Resume depends on the tool CLI. A session that the CLI cannot find, or one that is cut before the tool saved it, ends the rerun with a tool failure like any other.
- The interrupted step may leave partial changes. A restarted step has to work from them; a resumed one has its own memory of them.
- It costs extra tokens: the interrupted attempt is paid for, and a restart re-reads the step prompt.
- A step takes at most 5 steers. Later `now` prompts then wait for the next step, as `next-step` prompts do.
- A steer that arrives between two steps kills nothing: the next step simply includes the prompt.
- A stop request that arrives with a steer wins.
- The request is picked up within about half a second.

Injected prompts are also kept in the task file, in the body section `## Injected`, written when the prompt is injected (the control directory is deleted when the task leaves `running`). Each entry is `### <ISO time> — <who>`, then a `<!-- boof: mode=now applied=<ISO time> -->` line (the inject mode, and when the prompt reached the agent: the next step started, or the steered step ran again; `applied` is added later), then the text; who is the API client name, or `user` for the local principal and the UI. Files without the section still parse. The section is append-only: saving a task never drops entries. The task Editor shows it in the "Injected" tab, and the task view of the API and MCP has `body.injected` (the raw section text).

When a task runs again (a retry of a stopped or failed task, or the next of several runs), the earlier injected prompts are not lost: the prompts of every step include them under `## Earlier injected instructions`, so the agent keeps following them. Prompts injected during the new run use the live mechanism above.

This gives the user a practical way to steer a long-running task between steps without changing the whole tool architecture.

## Architecture of the API layer

Everything a client can do is one **operation**, defined once with `defineOp()` in `packages/api/src/ops/` (projects, plans, tasks, admin, webhooks, whoami). An operation holds its name (`plans.sync`), scope(s), Zod input and output schemas, a REST mapping (method, path, status, `If-Match` field, ETag, idempotency), an optional MCP mapping (tool name and annotations) and a handler. The list is the **registry** (`registry.ts`). Three things are generated from it, so they cannot drift apart:

- **REST routes.** `packages/web/src/rest.ts` mounts one Hono route per operation under `/api/v1` (and the deprecated unversioned `/api` copies). It maps path and query parameters, JSON bodies, `If-Match` and `Idempotency-Key` onto the input.
- **MCP tools.** `packages/mcp` serves every operation with `mcp.expose` as a tool (32 today, `boof_<verb>_<noun>`), plus resources and two prompts.
- **OpenAPI and the harness guide.** `buildOpenApi(registry)` produces the OpenAPI 3.1 document (`GET /api/v1/openapi.json`, committed as `packages/api/openapi/openapi.json`). `scripts/gen-harness-reference.ts` turns it into the REST reference of `docs/harness.md` and writes `packages/web/src/generated/harness.ts`, the copy the server embeds.

`Operation.execute` is the only way in. It checks the scope (an empty scope list, as in `auth.whoami`, means any authenticated caller), validates the input (`400 invalid_input` or `invalid_plan`), authorizes the project (`403 forbidden_project`), runs the handler, validates the output and maps every failure to an `OpError` with a stable code from `ERROR_CODES`. REST and MCP therefore share scopes, project restrictions, trust rules, validation and error codes.

### Request chain

For `/api/*` and `/mcp`: host guard (`421`), secure headers, audit (outermost, so rejected calls are logged), body limit (`413`), for `/mcp` an `Origin` check, `authenticate`, rate limit (`429`), then the route. The public routes `GET /harness.md`, `/harness.txt` and `/llms.txt` are registered after the host guard and secure headers and before authentication: they hold no secrets and serve `docs/harness.md` as embedded text.

### Events and webhooks

Every status change and plan write appends one JSON line to `<project>/events.jsonl` (runner toggles and `runner.budget_exceeded` to `<data>/events.jsonl`; files rotate monthly). `GET /api/v1/events` streams them as server-sent events with opaque cursors, replayable with `since` or `Last-Event-ID`, plus unnumbered `changed` hints from the file watcher. `WebhookDispatcher` (web process only) delivers the same events to `settings.webhooks` with an HMAC-SHA256 signature, retries and a dead-letter directory. See [api.md](api.md).

### MCP

`boof-runner mcp` serves stdio (`--client` picks an API client, `--project` fixes the project); `POST /mcp` serves Streamable HTTP in stateless mode (a fresh server per request, JSON responses, no sessions). The principal comes from the same authenticator as REST, so revocations apply at once. A tool call runs `op.execute` and is audited as `mcp:<tool>`.

## Web API And UI

The REST surface is the registry (see above); the full list with inputs, outputs, scopes and errors is the generated reference in [harness.md](harness.md) and the OpenAPI document. In short:

- projects: list, create, get, update, archive, unarchive, pause, resume, delete (`?purge=true` removes the data and is refused with `409 project_busy` while a task runs), usage
- per-project tasks under `/api/v1/projects/{p}/tasks…`: CRUD, reorder, skip, retry, archive, unarchive, delete, queue, answers for parked tasks, attachments, live log, wait (long poll), stop and prompt injection (modes `next-step` and `now`)
- per-project plans under `/api/v1/projects/{p}/plans…`: list, create, get, update, replace goals, upsert and remove a goal, reorder, goal status, repo import, XML export, sync (`dryRun`). Writes honour `If-Match: "<version>"` or `expectedVersion`
- `GET /api/v1/actions`, `GET /api/v1/whoami`, runner status and toggle, command templates, settings, tool health, models, token usage, API clients (`auth:admin`) and webhooks (`admin`)

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

Authentication is middleware in `packages/web/src/middleware/`. The operations declare their scope in the registry, `execute` enforces it, and `authorizeProject()` runs before any project access.

- Principals: `local` (loopback peer, no `Authorization` header, no `X-Forwarded-For`, `security.auth.mode = "local-trust"`; all scopes, `trusted`) or a client holding a key `boof_<clientId>_<base64url(32 bytes)>`. Only `sha256(secret)` is stored, in `<data>/auth/clients.json` (mode 0600), compared with `timingSafeEqual`.
- Scopes: `projects:read|write`, `plans:read|write`, `tasks:read|write|control` (stop, inject), `settings:read|write`, `runner:control`, `auth:admin`, `admin` (everything). Pause and resume accept `runner:control` or `projects:write`; toggling the runner accepts `runner:control` or `settings:write`; usage accepts `projects:read` or `tasks:read`. `auth.whoami` needs no scope.
- Project restriction: a client may be limited to a list of projects; other projects answer `403 forbidden_project` (so existence is not probed) and list routes filter. A non-local principal registering a project (or moving its working directory) must pass `security.allowedProjectRoots`, the git and data-root checks and the `/`/home exclusion, else `403 project_root_not_allowed`.
- Trust: `review` clients (the default) create tasks and plans as `draft` (tasks get the label `external:<id>` and an `origin`), and cannot queue, retry, unarchive, answer, activate a plan or edit an active plan: `403 forbidden_trust`. `security.externalTasksRequireApproval = false` lifts this. `trusted` clients behave like local.
- Admin API (`auth:admin`): list, create, revoke and rotate clients. Responses never contain `keyHash`; a caller cannot grant scopes or trust it does not hold.
- Settings (`settings.security`, edited in `settings.json`, not through `PUT /settings`): `allowedHosts`, `auth.mode`, `allowedProjectRoots`, `externalTasksRequireApproval`, `rateLimit`, `audit`. `settings.mcp.enabled` switches MCP off.
- Binding: `--host`/`BOOF_RUNNER_HOST`; a non-loopback bind needs `auth.mode = "required"` and an active client; the bind host is added to the Host allow-list. `--tls-cert`/`--tls-key` serve HTTPS.

## Persistence And Safety

The most important safety mechanisms are:

- Atomic writes: files are written through a temp file that is fsynced, then renamed, and the directory is fsynced after it, so a crash leaves the old or the new file, never a partial one. Creating a task is exclusive: it fails with a conflict if the id exists.
- Locks (within one process): `TaskStore` serializes every operation on one task id (create, save, modify, transition, delete), so a claim and an edit cannot interleave. Settings, project and auth read-modify-write cycles (`SettingsStore.mutate`, the project and auth stores) each run under one lock, and a plan sync runs under a per-plan lock. A writer that owns only some fields uses `TaskStore.modify` and keeps the edits made since it loaded its copy.
- Status state machine: illegal task transitions are rejected.
- Directory reconciliation: status directories repair mismatched task frontmatter.
- Single-runner guard: the CLI prevents duplicate runner loops for the same data root.
- Across processes (the CLI next to the server) these locks do not apply. Only whole-file atomic writes, exclusive task create and `<root>/.migration.lock` hold, so two processes that edit the same task, settings or plan at once can lose one update. Data roots shared across hosts are not supported: the migration lock names a pid, which means nothing on another machine.
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
- Token/cost handling is tracking-only; it does not enforce budgets yet.

These tradeoffs are acceptable for a local code-execution runner, but they should be revisited if Boof Runner becomes a multi-user or remote system.

## Suggestions

The highest-value next improvements are:

1. Add a worktree review screen

   The reviewer sees the diff, but users would benefit from a UI view that shows the actual branch/worktree diff before retrying, archiving, or accepting a result.

2. Support interactive tool sessions when available

   Inject mode `now` interrupts the step and resumes the tool session. True mid-run injection without the interruption would require interactive sessions or a tool-specific control protocol. If Claude Code or Codex expose stable session APIs, Boof Runner should add adapters that can send input into an active session.

3. Add budget controls

   Usage tracking exists, but there are no hard limits. Add optional per-run, per-day, or per-tool caps with clear behavior when a limit is reached.

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
