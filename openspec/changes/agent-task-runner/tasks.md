## 1. Monorepo & tooling setup

- [x] 1.1 Scaffold the monorepo: `packages/shared`, `packages/web`, `packages/runner`, `bin/`, and a default `data/` root; configure workspaces so `shared` is importable by `web` and `runner`
- [x] 1.2 Configure TypeScript (strict), build for Bun + Node ≥ 20, and set up the test runner to execute on Node in CI
- [x] 1.3 Add baseline dependencies (`zod`, `gray-matter`, `chokidar`, Hono, React/Vite, `dnd-kit`, CodeMirror 6) and lint/format config
- [x] 1.4 Add a `runtime` adapter module in `shared` wrapping divergent Bun/Node APIs (file ops, process spawn, server bind)

## 2. Shared data model (task-file, command-templates, settings)

- [x] 2.1 Define `zod` schemas for task frontmatter, command-template frontmatter, and `settings.json`
- [x] 2.2 Implement frontmatter parse/serialize with named body-section round-tripping (`## Prompt`, `## Command`, `## Questions`, `## Answers`, `## Reports`)
- [x] 2.3 Implement deterministic kebab-case id generation with illegal-char stripping and uniqueness suffixing
- [x] 2.4 Implement atomic write (temp + rename) and per-file locking; ensure `updated` refreshes while `created` is preserved
- [x] 2.5 Implement command-template parse/serialize, auto-derived id, CRUD helpers, rename-and-relink, and `## Command` injection
- [x] 2.6 Implement settings load/save with defaults, role assignment resolution (global + per-task `tools` override), and per-tool model lists
- [x] 2.7 Unit tests: frontmatter round-trip, id generation, command injection, settings validation

## 3. Task lifecycle & state machine

- [x] 3.1 Implement the state machine gating legal transitions (`draft|pending|running|action|done|failed`, plus retry)
- [x] 3.2 Implement status-directory path helpers and write-then-move status changes that keep directory and `status` field in sync
- [x] 3.3 Implement reconciliation (location-authoritative repair) and orthogonal `skip` handling
- [x] 3.4 Unit tests: valid/invalid transitions, file moves, skip exclusion, reconciliation after interrupted move

## 4. Tool abstraction & adapters

- [x] 4.1 Define the `Tool` interface (`id`, `displayName`, `defaultModels`, `detect()`, `run(opts)`)
- [x] 4.2 Implement the first-class **mock** adapter (deterministic plan/report, configurable questions, no network)
- [x] 4.3 Implement the **claude-code** adapter (non-interactive + auto-approve flags, scoped `cwd`, stdout/stderr capture)
- [x] 4.4 Implement the **codex** adapter (same contract)
- [x] 4.5 Implement `detect()` health checks for each tool and a tool registry
- [x] 4.6 Parse token usage/cost from tool output (best-effort; unknown on absence)
- [x] 4.7 Tests: mock determinism, mock-emits-questions, health detection present/absent (mocked CLI)

## 5. Worktree isolation

- [x] 5.1 Verify `workingDirectory` is a git repo; warn loudly and refuse isolated runs otherwise
- [x] 5.2 Create a per-task git worktree/branch rooted at `workingDirectory` on task start
- [x] 5.3 Provide base-diff retrieval for the reviewer step
- [x] 5.4 Implement worktree cleanup on done/failed and stale-worktree pruning on startup
- [x] 5.5 Tests: creation, diff, cleanup, and refusal on non-git dir (using a temp git repo)

## 6. Runner & pipeline

- [x] 6.1 Implement the polling loop: watch `settings.json`, poll `tasks/pending/`, select by `priority` desc (tiebreak `updated`), exclude `skip:true`, one task at a time
- [x] 6.2 Implement cooperative on/off (step-boundary check) and block-hours idling (empty placeholder = never idle)
- [x] 6.3 Implement task start: move to `tasks/ongoing/<id>/`, set `running`, create working area (`task.md`, `plan.md`, `reports/`, `log.txt`), ensure command-template definition present
- [x] 6.4 Implement the four pipeline steps (planner → refinement → developer → reviewer), wiring `plan.md` and diff as inputs and writing a report per step; record token usage per step + global aggregate
- [x] 6.5 Implement the planner questions park-and-continue loop (append `## Questions`, set `questions: pending`, move to `actions/`, continue other work) and answered-resume (back to `pending`, no re-prompt)
- [x] 6.6 Implement developer/reviewer → planner question routing via file (never surfaced to user)
- [x] 6.7 Implement failure handling (crash/non-zero/timeout → `failed/`, diagnostics in `log.txt`) and retry to `pending`
- [x] 6.8 Move to `done/` with `status: done` on full success
- [x] 6.9 Integration tests against the mock tool: full happy-path pipeline, directory moves, report creation, and question → park → answer → resume loop

## 7. Web server

- [x] 7.1 Bootstrap the Hono server (Bun + Node), localhost-only, serving the built UI
- [x] 7.2 Implement the file-backed task API: list, read, create/save (validated, atomic, status/dir sync), toggle skip, reorder priorities, retry, submit answers
- [x] 7.3 Implement command-template and settings endpoints (incl. runner on/off, working dir, roles, model lists) and a tool health-check endpoint
- [x] 7.4 Implement `chokidar` watch → SSE live updates with debounce; clients reconcile from a fresh list on reconnect
- [x] 7.5 Tests: API validation/rejection, reorder rewrites priority, SSE emits on file change

## 8. Web UI

- [x] 8.1 App shell with navigation (task list, Command tab, Actions tab, Settings) and the SSE live-update client
- [x] 8.2 Task list: status badge, priority, labels, skip checkbox, `dnd-kit` drag-and-drop that rewrites priority, label grouping/filter, live updates
- [x] 8.3 Editor: markdown prompt editor, priority field, command-template selector that sets `command` + injects `## Command`, save
- [x] 8.4 Command tab: list/create/edit/delete templates with read-only derived id
- [x] 8.5 Actions tab: list `questions: pending` tasks, render `## Questions`, submit answers (write `## Answers`, set `answered`, return to `pending`)
- [x] 8.6 Runner on/off toggle reflecting `settings.runner.enabled`
- [x] 8.7 Settings page: working dir + subdirectory picker, per-tool health status, role/model selectors (add models), token usage/cost display, placeholder cards (block hours, better-ccflare)

## 9. CLI & packaging

- [x] 9.1 Implement the `bin` entry: resolve/scaffold the data root (status dirs, `commands/`, default `settings.json`), preserving existing data
- [x] 9.2 Boot the web server and ensure a single runner (pidfile/lock guard against duplicates); no OS boot service
- [x] 9.3 Support a configurable data-root path
- [x] 9.4 Package metadata (`bin`, runnable via `bunx`/`npx`); build for npm but do not publish

## 10. End-to-end & acceptance

- [x] 10.1 Web E2E (mock tool): create draft → save → enqueue → reorder → run → answer questions → reaches `done`
- [x] 10.2 Verify all pipeline tests run offline via the mock tool (no network/token use in CI)
- [x] 10.3 Verify dual-runtime: run the suite on both Bun and Node ≥ 20
- [x] 10.4 Final pass over acceptance criteria from the specs (status moves, artifacts/reports, questions loop, health checks)
