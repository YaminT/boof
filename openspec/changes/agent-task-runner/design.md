## Context

This is a greenfield, local-first, single-user system. There is no existing codebase, no auth, and no remote hosting — everything lives on local disk and serves `localhost`. The defining constraint is that **task markdown files and `settings.json` are the single source of truth**, shared by two cooperating processes (the web server and the background runner). Both read and write the same files; neither owns a database. The system must run on both **Bun (first-class) and Node.js ≥ 20**, and be structured for eventual npm packaging (built for it, not published this iteration).

The pipeline drives pluggable coding-agent CLIs (claude-code, codex) in auto-approve mode through planner → developer → reviewer. Because auto-approve mode mutates a real working tree unattended, isolation and reviewability are first-class concerns.

The proposal's resolved decisions (from the spec's open questions): token system = **usage/cost tracking only**, isolation = **git worktree per task**, build scope = **full vertical slice**, concurrency = **one task at a time**, planner question = **park-this-task-and-continue**, runner "off" = **finish current step gracefully**, no OS boot service.

## Goals / Non-Goals

**Goals:**
- A monorepo (`shared`, `web`, `runner`, `bin`) where `shared` owns the data model and is imported by both other packages.
- Filesystem-as-truth coordination that is safe under two concurrent writers (atomic writes + per-file locks + watch-based reconciliation).
- A fixed, reviewable pipeline with a report at every step and isolated per-task git worktrees.
- A pluggable `Tool` abstraction with a first-class offline **mock** tool so the entire pipeline is testable without network/tokens.
- A web UI that manages the queue and parks/answers planner questions, updating live via SSE.
- A CLI that scaffolds the data root and boots web + runner; portable across Bun/Node.

**Non-Goals:**
- Multi-user, auth, remote hosting, cloud storage.
- npm publish; OS boot/autostart service.
- Budget enforcement / runner pausing on token spend (tracking only).
- N-way task concurrency (single-task now; configurable later).
- Real block-hours scheduling (placeholder UI/setting only).

## Decisions

### D1. Monorepo with a shared data-model package
Three packages plus `bin/`. `shared` holds the `zod` schemas, frontmatter parse/serialize, id utilities, the state machine, path helpers, and the runtime adapter. **Why:** the task-file contract must be identical in the web server and the runner; duplicating it invites drift. *Alternative considered:* a single package — rejected because the runner and web have different runtime profiles (long-lived loop vs. request/response) and clearer boundaries aid the future npm packaging.

### D2. Frontmatter is authoritative; body sections are structured text
Use `gray-matter` to split frontmatter from body, validate frontmatter with `zod`, and parse the body into named sections by `##`/`###` headers. All the original scattered markers (`skip`, `draft`, `# command:`, `#hasQuestions`) collapse into frontmatter fields. **Why:** one source of truth avoids reconciling two. *Alternative considered:* inline markers as primary — rejected (two sources of truth, fragile grep parsing).

### D3. Atomic writes + per-file locks
Every write goes to `*.tmp` then `rename()` (atomic on POSIX); a per-file in-process mutex plus an on-disk lock (e.g. lockfile) serializes writers so the web and runner never interleave. Status changes are ordered **write-then-move**. **Why:** two processes mutate the same files; a half-written or interleaved file would corrupt the source of truth. *Alternative considered:* a single writer process with the other proxying through it — rejected as heavier and against the "filesystem is the API" model.

### D4. Status as physical directory + reconciliation
The directory (`drafts/`, `pending/`, `ongoing/`, `actions/`, `done/`, `failed/`) always mirrors the `status` field. On any disagreement (e.g. crash mid-move), the location is authoritative and the file is repaired to match. **Why:** the original spec mandates physical moves; directory listing becomes a cheap queue query. The state machine in `shared` is the single gate for legal transitions.

### D5. `Tool` interface with claude-code / codex / mock adapters
Each adapter shells out to its CLI non-interactively with auto-approve flags, scoped strictly to `cwd`, capturing stdout/stderr to `log.txt`, and returns `{ output, report, questions? }`. The **mock** adapter is first-class and deterministic (canned plan/report/questions, configurable to emit questions). **Why:** new tools must drop in without touching the pipeline, and CI must never spend tokens. Token usage is parsed from tool output here (D8). *Alternative considered:* SDK/library integration per tool — rejected for now; shelling out matches how these CLIs are actually run and keeps the abstraction uniform.

### D6. Git worktree per task
Require `workingDirectory` to be a git repo. On task start, create a dedicated worktree/branch; the developer runs with `cwd` = worktree; the reviewer diffs worktree against base; cleanup removes the worktree on done/failed. **Why:** auto-approve mutation on a shared tree is unsafe and unreviewable; worktrees isolate and make every run revertible. Single-task concurrency already prevents two agents fighting one tree, but worktrees additionally give a clean diff for review. *Alternative considered:* operate directly on the shared dir — rejected for safety/reviewability (still offered as a fallback only when the dir is not a git repo, with a loud warning and no isolation).

### D7. Runner loop, cooperative on/off, park-and-continue
A polling loop reads `settings.json` (watched) and `tasks/pending/`. It selects one task by `priority` desc (tiebreak `updated`), excluding `skip:true`. "Off" is checked at step boundaries so the in-flight step finishes gracefully. Planner questions park the task to `actions/` and the loop continues with other work; developer/reviewer questions are answered by a planner session via file and never surface to the user. **Why:** matches the resolved open-question answers; step-boundary checks avoid corrupting an in-flight tool run.

### D8. Token tracking, no enforcement
Adapters parse token/cost from tool output where present; the runner records per-step usage into the task working area and a global aggregate, surfaced in the UI. No caps, no pausing. **Why:** the chosen iteration scope; enforcement adds runner-control complexity not yet wanted. Schema leaves room (`settings.tokens`) to add caps later.

### D9. Hono server + chokidar → SSE; React + Vite UI
Hono runs on both Bun and Node and serves the built UI plus a file-backed REST API. `chokidar` watches the data root and pushes SSE events so the browser reflects runner-driven changes without polling. UI uses React + Vite, `dnd-kit` for drag-and-drop priority, and CodeMirror 6 (or a markdown editor) for the prompt. **Why:** portability (Hono/chokidar work on both runtimes) and the suggested-library set. *Alternative considered:* WebSocket — SSE is simpler for one-way server→client updates and sufficient here.

### D10. Runtime adapter for Bun/Node portability
A thin `runtime` module in `shared` wraps any divergent APIs (file ops, process spawn, server bind). Shared/runner code never calls Bun-only APIs directly. **Why:** the dual-runtime requirement; isolating differences keeps the rest of the code uniform and testable on Node in CI.

### D11. CLI scaffolds then supervises
The `bin` entry resolves/creates the data root (status dirs, `commands/`, default `settings.json`), then boots the web server and ensures a single runner (guarded against duplicates, e.g. a pidfile/lock). No boot service. **Why:** first-run UX and the "starts when the app launches" persistence model.

## Risks / Trade-offs

- **Two writers corrupting a shared file** → atomic temp+rename, per-file locks, and write-then-move ordering; reconciliation repairs any crash-interrupted move (D3, D4).
- **Auto-approve agents damaging the working tree** → mandatory git repo + per-task worktree isolation, scoped `cwd`, never run at root; non-git dirs warn and refuse isolated runs (D6).
- **CLI flag/output drift across tool versions** → confine all CLI specifics to adapters behind the `Tool` interface; the mock tool keeps the pipeline and CI independent of any real CLI (D5).
- **Watch/event storms or missed events from rapid file moves** → debounce chokidar; treat SSE as a hint and let clients reconcile from a fresh list on reconnect; the filesystem (not the event) is truth (D9).
- **Bun-only APIs leaking into shared/runner code** → centralize in the runtime adapter and run the test suite on Node in CI to catch leaks (D10).
- **Worktree leakage on crash** → cleanup is idempotent and also runs on startup (prune stale per-task worktrees) so failures don't accumulate (D6, D11).
- **Token parsing brittleness** → treat usage as best-effort; missing data records as unknown and never fails the pipeline (D8).
- **Duplicate runner processes** → single-runner guard (pidfile/lock) in the CLI; the runner also no-ops if it detects another active instance (D11).

## Migration Plan

Greenfield — no migration. Deployment is `bunx`/`npx` invocation of the `bin` entry; first run scaffolds the data root. "Rollback" is removing the data root (user data) and the package; existing task files remain plain markdown and are not destroyed by uninstall. Forward-compatibility for later iterations (budget caps, real block-hours, N-way concurrency) is reserved via existing settings fields rather than schema changes.

## Open Questions

- **Lock mechanism specifics** — in-process mutex is clearly needed; confirm whether an on-disk lockfile (e.g. `proper-lockfile`) is also warranted given single-machine, two-process access, or whether atomic rename + ordered operations suffice.
- **Priority value assignment on drag** — confirm the exact remap (e.g. renumber affected tasks with gaps like 10/20/30, or normalize the whole list) so reordering stays stable; spec fixes "integer, higher = sooner" but not the gap strategy.
- **Refinement pass scope** — the second planner pass is always run in this design; confirm whether it should be conditional (skip when the first plan is already high-confidence) to save tokens.
- **Worktree vs. branch** — design assumes worktrees; confirm acceptable to require git ≥ a version supporting `git worktree`, or whether a branch-only fallback is needed for older gits.
