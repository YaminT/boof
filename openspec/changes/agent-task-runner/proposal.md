## Why

Driving coding agents (Claude Code, Codex, …) through a disciplined planner → developer → reviewer pipeline today means babysitting each run by hand: copying prompts, watching for clarifying questions, and tracking what ran where. There is no local-first way to queue prompts, prioritize them, and let a background process execute them through a fixed, reviewable pipeline. This change builds that system: a single-user, local-disk app where each task is a self-contained markdown file (the source of truth), a web UI manages the queue, and a background runner executes tasks with pluggable tools/models, parking for user input when the planner needs it.

## What Changes

- Introduce a **monorepo** (`packages/shared`, `packages/web`, `packages/runner`, `bin/`) in TypeScript that runs on both **Bun and Node.js ≥ 20**, with Bun-specific code hidden behind a runtime adapter.
- Define a **task file format**: one markdown file per task with canonical `zod`-validated frontmatter (`id`, `title`, `status`, `priority`, `skip`, `labels`, `command`, `questions`, per-task `tools`, timestamps) plus structured body sections (`## Prompt`, `## Command`, `## Questions`, `## Answers`, `## Reports`). All writes are atomic (temp + rename) and per-file locked.
- Define a **command-template format** (`commands/*.md`) with auto-derived kebab-case ids, editable in a Command tab, injected verbatim into a task's `## Command` on save.
- Implement a **status lifecycle** where tasks physically move between status directories (`drafts/`, `pending/`, `ongoing/`, `actions/`, `done/`, `failed/`) kept in sync with the `status` field, governed by an explicit state machine.
- Build a **background runner**: polls `pending/`, selects by `priority` (one task at a time), and drives each through **planner → planner-refinement → developer → reviewer**, writing a report at every step. Controlled at runtime by `settings.runner.enabled`; finishes the in-flight step gracefully on "off"; idles during block hours (placeholder). No OS boot service — starts after install and when the app launches.
- Implement the **questions/answers loop**: the planner may raise clarifying questions → task parks in `actions/` (`questions: pending`) while the runner continues other work; the user answers in the Actions tab → task resumes from `pending/`. Developer/reviewer questions are routed to the planner via file, never surfaced to the user.
- Define a **`Tool` abstraction** with built-in **claude-code**, **codex**, and a first-class **mock** adapter (canned output, no network) for offline testing, plus per-tool **health checks** and extensible model lists.
- Run each task in a **git worktree per task** rooted at `workingDirectory`, so developer changes are isolated and the reviewer can diff against base; worktree cleaned up on completion. `workingDirectory` must be a git repo.
- Add **token usage/cost tracking** (per-task and global, parsed from tool output and surfaced in the UI; no budget enforcement this iteration).
- Build the **web interface** (React + Vite) — task list with drag-and-drop priority and skip toggle, markdown editor, Command tab, Actions tab, runner on/off toggle, and a Settings page (working directory + subdirectory picker, health checks, role/model selectors, token display, block-hours and better-ccflare placeholder cards) — served by a **Hono server** that exposes a file-backed API and pushes live updates via file-watch → SSE.
- Provide a **CLI `bin` entry** (runnable via `bunx`/`npx`) that boots the web server, ensures the runner, and on first run scaffolds the data root + `settings.json`. Built for npm packaging but **not published** this iteration.
- Establish an **offline test suite** (unit, integration, web E2E) that drives the full pipeline against the mock tool so CI never burns real tokens.

## Capabilities

### New Capabilities

- `task-file`: Canonical task markdown format — frontmatter `zod` schema, parser/serializer with body-section round-tripping, deterministic kebab-case id generation with uniqueness, and atomic+locked reads/writes.
- `command-templates`: Command-template file format, auto-derived ids, CRUD operations, rename-and-relink, and injection of template bodies into a task's `## Command` section.
- `settings`: `settings.json` schema and store — runner flag, working directory + subdirectory, block-hours placeholder, role assignments (planner/developer/reviewer = tool + model), and per-tool model lists; watched for changes.
- `task-lifecycle`: Status state machine (`draft|pending|running|action|done|failed`), the orthogonal `skip` flag, and physical movement of task files between status directories kept in sync with the `status` field.
- `tool-adapters`: The `Tool` interface, built-in claude-code/codex/mock adapters that shell out non-interactively with auto-approve, per-tool health detection, and extensible model lists.
- `worktree-isolation`: Per-task git worktree creation rooted at `workingDirectory`, scoped agent execution, base-diff support for the reviewer, and cleanup on completion.
- `runner-pipeline`: The background runner loop — selection by priority, single-task concurrency, runtime on/off and block-hours idling, the planner → refinement → developer → reviewer pipeline with per-step reports, the planner questions/answers park-and-resume loop, planner-mediated developer/reviewer questions, and failure handling with retry.
- `token-tracking`: Per-task and global token usage/cost capture from tool output, persisted alongside task artifacts and surfaced in the UI (tracking only, no enforcement).
- `web-server`: The Hono HTTP server — serves the built UI, exposes a file-backed REST API over tasks/commands/settings, and pushes live updates via `chokidar` file-watch → SSE.
- `web-ui`: The React UI — task list (drag-and-drop priority, skip, label grouping), markdown editor, Command tab, Actions tab (answer questions), runner on/off toggle, and Settings page.
- `cli-packaging`: The `bin` CLI entry that boots web + ensures runner, first-run scaffolding of the data root and `settings.json`, and the Bun/Node runtime adapter for portable packaging.

### Modified Capabilities

<!-- None — this is a greenfield project with no existing specs. -->

## Impact

- **New monorepo** in TypeScript with three packages (`shared`, `web`, `runner`) plus `bin/` and a default `data/` root; build tooling for Bun + Node ≥ 20.
- **New runtime dependencies (suggested, swappable):** Hono, React + Vite, CodeMirror 6 (or a markdown-editor component), `dnd-kit`, `gray-matter`, `zod`, `chokidar`.
- **External CLI dependencies** detected at runtime via health checks: `claude-code`, `codex` (optional; mock tool covers offline use). Requires `git` and a git-repo `workingDirectory` for worktree isolation.
- **Filesystem is the source of truth**: both the web server and the runner read/write the same task files and `settings.json`; coordination via atomic writes + per-file locks and file-watch reconciliation.
- **No multi-user/auth/remote, no cloud storage, no npm publish, no OS boot service** in this iteration.
- **Test/CI**: a mock-tool-driven offline suite (unit + integration + web E2E) is added so pipeline tests never make network calls.
