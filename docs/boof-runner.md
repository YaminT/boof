# Boof Runner

Boof Runner is the code-execution runner of the boof project. It turns user tasks into a controlled local workflow that can plan, implement, review, and record code changes using coding-agent CLIs such as Claude Code and Codex.

Boof Runner is local-first. It runs on the user's machine, stores tasks as markdown files, serves a local web UI, and executes one task at a time against the configured working directory.

## What It Does

Boof Runner manages the full lifecycle of coding-agent work:

- It accepts task prompts from the UI or API.
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
- `packages/web`: the local HTTP API, file watcher, SSE updates, and service layer over the stores.
- `packages/web/ui`: the React UI for task management, settings, live logs, actions, and runtime controls.
- `packages/desktop`: the Electron wrapper that runs the same server, runner, and UI in a native window.
- `bin`: the `boof-runner` command that scaffolds the data root, starts the web server, and ensures only one runner is active.

## Core Design

Boof Runner has a simple coordination model: the filesystem is the source of truth.

There is no database. The web server and runner both read and write the same data root. Atomic writes, file locks, and status-directory reconciliation keep that safe enough for the local single-user model.

The default data root (layout v2, `settings.json` has `schemaVersion: 2`) contains:

```text
settings.json
commands/
auth/
audit/
projects/
  <projectId>/
    project.json
    tasks/
      drafts/
      pending/
      ongoing/
      actions/
      done/
      failed/
      archived/
      assets/
    usage.json
```

### Projects

A project is one git repository with its own queue. `project.json` (`ProjectSchema`) holds the `id` (the directory name, kebab-case), `name`, `workingDirectory` (a realpath, resolved when the project is created), `paused`, `archived`, an optional `defaultBase` ref, `labels`, `origin` (`ui`, `cli`, `api` or `migration`) and optional per-project overrides of `roles`, `review`, `worktree` and `retries`. Global settings stay in `settings.json`; the runner merges them per key with the project's overrides (`effectiveSettings`), the project winning, and takes the working directory from the project.

Every task path helper takes a `root`. For a project that root is `projects/<id>/`, so `TaskStore`, `AttachmentStore` and `UsageStore` are used unchanged, one instance per project. Tasks do not store their project: the directory is authoritative, as it is for status. Ids are per project (two projects can both have a task `fix-login`); API responses add `projectId`.

Creating a project (`ProjectStore.create`) resolves the realpath, requires a git work tree (the check is injected by the caller, so `shared` does not depend on `runner`), refuses a directory inside the data root or one that is already a project, and derives the id from the directory name. A project with an empty `workingDirectory` can only come from migrating a v1 data root that never had one; the runner skips it until a directory is set.

### Migration from v1

`migrateDataRoot` (shared) runs before any store opens: at server start, in the desktop app, and in `run`, `scan` and `project`. A missing `settings.json` becomes v2 defaults with no projects. A `settings.json` without `schemaVersion` is v1: `projects/default/project.json` is written from the old `workingDirectory`, `tasks/` and `usage.json` are renamed into `projects/default/`, then `settings.json` is rewritten last as v2 (`defaultProject: "default"`, `runner.concurrency: 1`, removed keys dropped) and `migration-v2.log` records what moved. Because the settings file changes last, a crash leaves a v1 file and the next start finishes the remaining steps; each step checks its own precondition. The migration refuses (and changes nothing) when `tasks/ongoing/` holds a task and `.runner.pid` names a live process. Worktrees live in the repository and are keyed by task id, so they are untouched.

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

This format keeps task data editable, inspectable, and portable outside the app.

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

The codex report is the file written by `codex exec --output-last-message`; stdout is the fallback when that file is missing or empty.

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
  - On failed or stopped, the worktree directory and the branch are kept as they are. The directory path, branch name and HEAD sha are logged.
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

A failure is transient when it is a tool error that was neither stopped nor timed out, and its output or stderr matches `API Error: 5xx`, `429`, `529`, `overloaded`, `temporarily unavailable`, `ECONNRESET`, `ETIMEDOUT` or `socket hang up` (exported as `isTransientToolError()`), or the stream stalled. Every retry is logged (`Transient failure in <step> (attempt a/n): …; retrying in Xs in the same worktree`). The stop signal is checked during the backoff: a stop request stops the task as usual. The retried step's prompt gains a `## Previous attempt interrupted` section telling the agent that the working directory may hold partial changes and to inspect `git status` and `git diff` and continue rather than restart. Non-transient errors, timeouts and stops are not retried.

The mock tool can simulate both: `[[mock-transient developer=1]]` fails the first N runs of a role with `API Error: 503`, and `[[mock-stall developer=1]]` makes them go silent.

## Non-Interactive Guard

Every role's system prompt (planner, refinement, developer, observer, reviewer, planner-answering) ends with a guard: the tool runs non-interactively, its process exits when the turn ends and kills anything in the background, so the agent must never end its turn while waiting on background work. Commands longer than about 10 minutes run in the background with an exit-status marker file and are awaited with repeated foreground loops under 10 minutes.

## Findings Across Iterations

With `runs > 1`, from iteration 2 on, every step's prompt gains `## Findings from the previous iteration`: the final observer report (if any) and final reviewer report of the previous iteration, verdict lines included.

## Tool Adapters

Tools are behind a shared `Tool` interface. The pipeline does not know how Claude Code or Codex are invoked; it only calls the registered tool.

Built-in tools:

- `claude-code`: runs the `claude` CLI in non-interactive mode.
- `codex`: runs the `codex` CLI in non-interactive mode.
- `mock`: deterministic offline tool used by tests.

Each tool can:

- report health
- list available models
- run a role-specific prompt
- stream output chunks
- return a report
- optionally return questions
- return best-effort token usage

The Settings page refreshes available models from the tools and uses a smoke prompt to confirm Claude and Codex are authenticated, not just installed.

## Runtime Controls

Boof Runner supports two runtime controls while a task is running.

### Stop

The UI can request a stop for the active task. The API writes a stop signal into the running task's control directory. The active child process polls for that signal and receives `SIGTERM`, followed by `SIGKILL` if it does not exit promptly.

The task is then recorded as failed with a clear stopped message. This is intentionally conservative: a stopped run may have partial changes in its worktree, its worktree and branch are kept for inspection or resume, so review them before retrying.

### Prompt Injection

The UI can inject an additional prompt while a task is running. Boof Runner writes that prompt to the running task's control directory and appends a note to the live log.

Because Claude Code and Codex are currently run non-interactively, injected prompts do not alter the already-executing CLI invocation. They are picked up before the next pipeline step and included in subsequent prompts under a dedicated injected-prompts section.

This gives the user a practical way to steer a long-running task between steps without changing the whole tool architecture.

## Web API And UI

The Hono server exposes a local REST API for:

- projects: `GET/POST /api/projects`, `GET/PUT/DELETE /api/projects/:pid` (`?purge=1` deletes the data, otherwise it archives; refused with `409 project_busy` while a task runs), `POST /api/projects/:pid/archive|unarchive|pause|resume`, `GET /api/projects/:pid/usage`
- per-project tasks under `/api/projects/:pid/tasks…`: CRUD, queue reordering, skip toggles, retry/archive/unarchive/delete, answers for parked tasks, attachments, live logs, stop and prompt injection (task responses carry `projectId`)
- `GET /api/actions`: tasks parked in `action` across the projects the caller may read
- command templates (global)
- settings (global; `defaultProject` is settable, the working directory is not)
- tool health
- model lists
- token usage: `GET /api/usage` is the sum over projects

The legacy `/api/tasks…` routes are aliases of `/api/projects/<settings.defaultProject>/tasks…`. They answer `Deprecation: true`, and `404 no_default_project` while no default is set. They go away in the release after the REST v1 work.

All `/api` requests must carry a loopback Host header (`localhost`, `127.0.0.1` or `[::1]`); other hosts get `421`. Errors have the shape `{ "error": { "code": "…", "message": "…" } }`. Status changes through the API are limited to `draft`, `pending` and `archived`; the runner owns `running`, `action`, `done` and `failed`.

The React UI consumes that API and listens to server-sent events from the file watcher. The watcher covers `projects/` (depth 6), `commands/` and `settings.json`; each `changed` event carries the JSON `{ "project": "<id>" }` when the path is under `projects/<id>/` and `{}` otherwise, and a client restricted to some projects only receives the events of its own. SSE events are only hints. After an event, the UI reloads current state from the filesystem-backed API.

Important UI areas:

- Tasks: queue, priority, status filters, running task live panel
- Editor: task prompt, labels, runs, command template, attachments, reports, logs
- Actions: parked planner questions awaiting user answers
- Commands: reusable instruction templates
- Settings: runner toggle, tool health, model lists, role assignments, usage

## API Authentication

Authentication is middleware in `packages/web/src/middleware/`. Order on `/api`: host guard, secure headers, audit (outermost, so rejected calls are logged), body limit, `authenticate`, rate limit, then the route, which declares its scope with `requireScope`.

- Principals: `local` (loopback peer, no `Authorization` header, `security.auth.mode = "local-trust"`; all scopes, `trusted`) or a client holding a key `boof_<clientId>_<base64url(32 bytes)>`. Only `sha256(secret)` is stored, in `<data>/auth/clients.json` (mode 0600), compared with `timingSafeEqual`.
- Scopes: `tasks:read`, `tasks:write`, `tasks:control` (stop, inject), `settings:read`, `settings:write`, `auth:admin`, `admin` (everything); `projects:*`, `plans:*` and `runner:control` are defined for the multi-project work. Current mapping: health, models and settings reads need `settings:read`; SSE events, commands reads and attachment reads need `tasks:read`; commands and attachment writes follow `tasks:write`; toggling the runner is a settings write. Project routes need `projects:read` (list, get, usage) or `projects:write` (create, update, archive, delete); pause and resume accept `runner:control` or `projects:write`; `/api/usage` and `/api/projects/:pid/usage` also accept `tasks:read`; task routes keep their task scopes. Every route with a project calls `authorizeProject()` before anything else (`403 forbidden_project`, so existence is not probed) and list routes filter to the allowed projects. A non-local principal registering a project (or moving its working directory) must pass `security.allowedProjectRoots`, the git and data-root checks and the `/`/home exclusion, else `403 project_root_not_allowed` (the allowed roots are listed in the error only for `admin`).
- Trust: `review` clients (the default) create tasks as `draft` with label `external:<id>` and an `origin` in the task frontmatter, and cannot move tasks to `pending` (retry, unarchive, answers, status update): `403 forbidden_trust`. `security.externalTasksRequireApproval = false` lifts this for tasks. `trusted` clients behave like local.
- Admin API (`auth:admin`): `GET/POST /api/auth/clients`, `POST /api/auth/clients/:id/revoke`, `POST /api/auth/clients/:id/rotate`. Responses never contain `keyHash`; a caller cannot grant scopes or trust it does not hold.
- Settings (`settings.security`, edited in `settings.json`, not through `PUT /api/settings`): `allowedHosts`, `auth.mode`, `allowedProjectRoots`, `externalTasksRequireApproval`, `rateLimit`, `audit`.
- Binding: `--host`/`BOOF_RUNNER_HOST`; a non-loopback bind needs `auth.mode = "required"` and an active client; the bind host is added to the Host allow-list. `--tls-cert`/`--tls-key` serve HTTPS.

## Persistence And Safety

The most important safety mechanisms are:

- Atomic writes: files are written through temp files and renamed.
- Per-file locks: concurrent writes to the same file are serialized.
- Status state machine: illegal task transitions are rejected.
- Directory reconciliation: status directories repair mismatched task frontmatter.
- Single-runner guard: the CLI prevents duplicate runner loops for the same data root.
- Worktree isolation: code mutation happens away from the main checkout where possible.
- Durable logs and reports: live output is mirrored back into the task file before final status transitions.
- Mock tool tests: most behavior is tested without network access or token spend.

## Important Tradeoffs

Boof Runner deliberately keeps the first version local, single-user, and file-backed. That makes it easy to inspect and recover data, but it also means:

- There is no multi-user permission model.
- There is no remote queue or hosted control plane.
- The runner processes one task at a time.
- Stop is best-effort and process-level, not a semantic rollback.
- Prompt injection is applied between non-interactive tool runs, not inside a currently running request.
- Token/cost handling is tracking-only; it does not enforce budgets yet.

These tradeoffs are acceptable for a local code-execution runner, but they should be revisited if Boof Runner becomes a multi-user or remote system.

## Suggestions

The highest-value next improvements are:

1. Add an explicit stopped status

   Today a stopped task is recorded as failed. A separate `stopped` status would make user intent clearer and allow different retry behavior.

2. Make injected prompts visible in the task editor

   Prompt injections are persisted in the running task control area and included in later prompts. They should also be mirrored into a durable task body section so users can inspect them after the task finishes.

3. Add a worktree review screen

   The reviewer sees the diff, but users would benefit from a UI view that shows the actual branch/worktree diff before retrying, archiving, or accepting a result.

4. Support interactive tool sessions when available

   True mid-run prompt injection would require interactive sessions or a tool-specific control protocol. If Claude Code or Codex expose stable session APIs, Boof Runner should add adapters that can send input into an active session.

5. Add budget controls

   Usage tracking exists, but there are no hard limits. Add optional per-run, per-day, or per-tool caps with clear behavior when a limit is reached.

6. Improve stop cleanup policy

   A stopped task keeps its partially modified worktree and branch today. Making this policy configurable (keep or discard) and adding UI choices such as retry from current state are follow-ups.

7. Expand model metadata

   The settings page currently shows model names. It could also show model source, availability, default role fit, and whether a health probe succeeded for that model.

8. Add structured event history

   Logs are useful but free-form. A structured event stream would make it easier to debug task lifecycle transitions, stops, injections, tool failures, and retries.

9. Prepare for multiple runners cautiously

   The current one-task-at-a-time model is simple and safe. If concurrency is added, it should preserve per-task worktree isolation and add explicit resource limits.

## Summary

Boof Runner is the execution engine of the boof project. It takes local task files, runs coding-agent tools through a fixed planner/developer/reviewer pipeline, isolates code changes in git worktrees, exposes progress through a local web UI, and records durable results back to plain markdown.

Its core strength is controlled local automation: users can queue work, watch it run, intervene when needed, and keep the full history on disk.
