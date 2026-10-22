# Boof Runner

Boof Runner is the code-execution runner for the Boof Runner project. It turns user tasks into a controlled local workflow that can plan, implement, review, and record code changes using coding-agent CLIs such as Claude Code and Codex.

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

## How It Fits In Boof Runner

Boof Runner is the broader project. Boof Runner is the runner part of that system: the component responsible for code execution.

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

The default data root contains:

```text
settings.json
commands/
tasks/
  drafts/
  pending/
  ongoing/
  actions/
  done/
  failed/
  archived/
  assets/
```

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

The runner polls `tasks/pending/`, chooses the highest-priority non-skipped task, and transitions it to `tasks/ongoing/<task-id>/`.

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

When `settings.workingDirectory` is a git repository, Boof Runner creates a dedicated git worktree for a running task. Agent tools execute inside that worktree, not directly in the main checkout.

This matters because the agents run in auto-approve mode. Worktree isolation gives Boof Runner:

- a contained place for file mutations
- a clear diff for review
- work that is never destroyed:
  - Task branches `boof-runner/<id>` are never deleted.
  - On done, uncommitted leftovers are committed on the branch as `boof-runner: <title>`, then only the worktree directory is removed with `git worktree remove` (no `--force`). If the commit or the removal fails, the directory is kept and the reason is logged.
  - On failed or stopped, the worktree directory and the branch are kept as they are. The directory path, branch name and HEAD sha are logged.
  - On retry, an existing task branch is reused. An unregistered directory at the worktree path fails the task and is never touched.
  - For done and failed tasks the branch name and HEAD sha are recorded in the task log.
- protection against one task corrupting the main working tree

If the configured directory is not a git repository, Boof Runner can run without isolation, but it records a warning and loses the worktree safety guarantees.

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

- task CRUD
- queue reordering
- skip toggles
- retry/archive/unarchive/delete
- answers for parked tasks
- attachments
- live logs
- stop and prompt injection
- command templates
- settings
- tool health
- model lists
- token usage

The React UI consumes that API and listens to server-sent events from the file watcher. SSE events are only hints. After an event, the UI reloads current state from the filesystem-backed API.

Important UI areas:

- Tasks: queue, priority, status filters, running task live panel
- Editor: task prompt, labels, runs, command template, attachments, reports, logs
- Actions: parked planner questions awaiting user answers
- Commands: reusable instruction templates
- Settings: working directory, runner toggle, tool health, model lists, role assignments, usage

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

10. Separate Boof Runner project docs from Boof Runner runner docs

As Boof Runner grows, the project should have a top-level architecture document that distinguishes Boof Runner's product surface from Boof Runner's runner responsibilities.

## Summary

Boof Runner is the execution engine of Boof Runner. It takes local task files, runs coding-agent tools through a fixed planner/developer/reviewer pipeline, isolates code changes in git worktrees, exposes progress through a local web UI, and records durable results back to plain markdown.

Its core strength is controlled local automation: users can queue work, watch it run, intervene when needed, and keep the full history on disk.
