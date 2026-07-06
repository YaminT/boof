# boof-runner — Agent Task Runner

> Installs the `boof-runner` command.

Queue prompts and run them through a disciplined **planner → developer → reviewer**
pipeline, driven by coding agents (Claude Code, Codex, …). Boof Runner is **local-first**:
every task is a self-contained markdown file on disk (the source of truth), a web UI
manages the queue, and a background runner executes tasks one at a time — parking for
your input when the planner needs clarification.

- **Filesystem is the source of truth** — one markdown file per task, atomic + locked writes.
- **Web UI** (React + Vite) over a **Hono** server with live updates via file-watch → SSE.
- **Background runner** drives each task through the pipeline, isolated in a git worktree.
- **Pluggable tools** — built-in `claude-code`, `codex`, and a first-class `mock` adapter
  (no network) so the full test suite runs offline.
- **Desktop app** (Electron) — runs the server, runner, and UI in one window; remembers
  your working directory between launches.
- **Prompt attachments** — drop images or PDFs onto a task's prompt; the runner exposes
  them to the agents for additional context.

> Single-user, local only. No auth, no cloud, no OS boot service.

## Requirements

- **Node.js ≥ 20** or **Bun** (the code runs on both)
- **git** — the runner isolates each task in a git worktree, so the configured
  _working directory_ must be a git repository
- Optional CLIs detected at runtime via health checks: `claude-code`, `codex`
  (the `mock` tool covers offline use)

## Quick start

```bash
bun install          # or: npm install
npm run build        # build the web UI + the CLI bundle
npm run dev          # run from source (tsx) — boots web + runner
```

Then open the URL it prints (default <http://127.0.0.1:4319>).

On first run Boof Runner scaffolds the data root (`./data` by default): the `tasks/` status
directories, a `commands/` folder, and `settings.json`.

### Desktop app

```bash
npm run desktop      # build the UI + Electron bundle, then launch the window
```

The desktop app boots the same Hono server and runner in its main process and opens the
UI in a native window. Its data root lives in the per-user app-data directory, so settings
persist across launches.

On first launch it asks for the **working directory** (a full-screen picker that opens a
native folder dialog). The choice is saved to `settings.json` and never asked again; change
it any time via the folder icon in the top-right header.

### Running the built CLI

```bash
node bin/dist/boof-runner.js          # after `npm run build`
boof-runner                      # after `npm install -g .`
```

### Install or update from source

```bash
bash scripts/install-or-update-boof-runner.sh
```

The script clones or fast-forwards the source checkout, installs dependencies, builds the
web UI and CLI, and globally links the `boof-runner` command. Set
`BOOF_RUNNER_DIR`, `BOOF_RUNNER_REPO`, or `BOOF_RUNNER_BRANCH` to override the source location.

### Options

| Flag                | Env             | Default   | Description               |
| ------------------- | --------------- | --------- | ------------------------- |
| `-d, --data <path>` | `BOOF_RUNNER_DATA_ROOT` | `./data`  | Data root directory       |
| `-p, --port <n>`    | `BOOF_RUNNER_PORT`      | `4319`    | Web server port           |
| `--no-runner`       | —               | runner on | Start the web server only |
| `-h, --help`        | —               | —         | Show help                 |

## How it works

A task moves physically between status directories under `<data>/tasks/`, kept in sync
with its `status` frontmatter field:

```
drafts/ → pending/ → ongoing/ → done/
                  ↘ actions/ (awaiting your answers)  ↘ failed/
```

The runner polls `pending/`, picks the highest-priority task, and runs
**planner → planner-refinement → developer → reviewer**, writing a report at every step.
If the planner raises clarifying questions, the task parks in `actions/` and the runner
moves on; you answer in the **Actions** tab and it resumes. Developer/reviewer questions
are routed back to the planner via file — never surfaced to you.

Turn the runner on/off any time from the UI; it finishes the in-flight step gracefully.

## Project layout

```
packages/shared    task-file format, schemas, lifecycle state machine, atomic store
packages/runner    tool adapters, git worktree isolation, the pipeline engine
packages/web        Hono server + file-watch SSE; React UI under packages/web/ui
packages/desktop    Electron app: boots the server + runner in-process, opens the UI window
bin/               the `boof-runner` CLI: scaffolds data, boots web, ensures a single runner
```

The `@boof-runner/*` packages are consumed from source and bundled into a single self-contained
CLI by tsup; the React UI is built by Vite and served by the Hono server.

For a deeper explanation of Boof Runner's runner responsibilities, architecture, and next
steps, see [docs/boof-runner.md](docs/boof-runner.md).

## Development

```bash
npm run dev          # boot from source (web + runner)
npm test             # full offline suite (unit + integration + web E2E, mock tool)
npm run typecheck    # tsc -b across all packages
npm run lint         # prettier --check
npm run format       # prettier --write
npm run build        # vite build (UI) + tsup bundle (CLI)
```

All pipeline tests drive the **mock** tool, so CI never makes network calls or burns tokens.
