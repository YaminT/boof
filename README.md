# boof-runner — Agent Task Runner

> Installs the `boof-runner` command.

Queue prompts and run them through a disciplined **planner → developer → reviewer**
pipeline, driven by coding agents (Claude Code, Codex, …). Boof Runner is **local-first**:
every task is a self-contained markdown file on disk (the source of truth), a web UI
manages the queue, and a background runner executes tasks one at a time — parking for
your input when the planner needs clarification.

- **Filesystem is the source of truth** — one markdown file per task, atomic + locked writes.
- **Web UI** (React + Vite) over a **Hono** server with live updates via file-watch → SSE.
- **Background runner** drives each task through the pipeline, isolated in a git worktree. Task branches (`boof-runner/<id>`) are never deleted, and the worktrees of failed or stopped tasks are kept.
- **Pluggable tools** — built-in `claude-code`, `codex`, and a first-class `mock` adapter
  (no network) so the full test suite runs offline.
- **Desktop app** (Electron) — runs the server, runner, and UI in one window; remembers
  your working directory between launches.
- **Prompt attachments** — drop images or PDFs onto a task's prompt; the runner exposes
  them to the agents for additional context.

> Single-user, local only. No cloud, no OS boot service. See [Security model](#security-model).

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

### Headless CLI (no web server)

The runner can be driven entirely from the command line — no web UI required. All
commands share `-d, --data <path>` (data root, or `$BOOF_RUNNER_DATA_ROOT`).

```bash
# Run a single prompt through planner → developer → reviewer and stream progress.
# Exits non-zero if the task fails or parks for answers.
boof-runner run "Add a rate limiter to the API" --repo /path/to/repo
boof-runner run --file task.md --repo /path/to/repo   # prompt from a file
boof-runner run --all                                 # drive the whole pending queue

# SCAN MODE — turn a boof-seeded repo's unfinished units into tasks.
# Walks <repo> for goal.boof.xml files whose current status is not `done`,
# creating one task per unit (ordered by plan.boof.xml order + depends-on, so a
# unit's dependencies run first). Each task instructs the developer to implement
# the unit strictly from its goal.boof.xml, TDD; on success the runner appends a
# <version> to that goal file bumping its status.
boof-runner scan /path/to/repo --dry-run   # list what it would create
boof-runner scan /path/to/repo             # create the tasks
boof-runner run --all -d ./data            # then drive them to completion
```

`run --repo` and `scan` set the data root's working directory to the given repository; a web UI or desktop app sharing the same data root will follow that change.

Useful flags: `--repo <dir>` (working directory the pipeline runs against — a git
repo enables worktree isolation), `--base <ref>` (branch or commit the task's worktree
starts from instead of HEAD), `--title <text>` (task title, default the first line of
the prompt), `--tool <id>`/`--model <name>` (force all roles to
one tool, e.g. `--tool mock` for offline runs), `--runs <n>` (iterate a task N times),
and, for `scan`, `--bump review|done` (status recorded on success, default `done`).

`scan`/`run` are **universal**: nothing about any specific project is hardcoded — the
target repo is always taken from the argument.

### Install or update from source

```bash
bash scripts/install-or-update-boof-runner.sh
```

The script clones or fast-forwards the source checkout, installs dependencies, builds the
web UI and CLI, and globally links the `boof-runner` command. Set
`BOOF_RUNNER_DIR`, `BOOF_RUNNER_REPO`, or `BOOF_RUNNER_BRANCH` to override the source location.
The default remote is `git@github.com:YaminT/boof.git`.

### Options (serve — the default command)

| Flag                | Env                     | Default   | Description               |
| ------------------- | ----------------------- | --------- | ------------------------- |
| `-d, --data <path>` | `BOOF_RUNNER_DATA_ROOT` | `./data`  | Data root directory       |
| `-p, --port <n>`    | `BOOF_RUNNER_PORT`      | `4319`    | Web server port           |
| `--no-runner`       | —                       | runner on | Start the web server only |
| `-h, --help`        | —                       | —         | Show help                 |

Run `boof-runner --help` for the full command reference (`serve`, `run`, `scan`).

### Worktrees, retention and retries

Each task runs in its own git worktree on branch `boof-runner/<id>`. Task frontmatter `base`
(or `run --base <ref>`) starts it from a branch or commit instead of HEAD; an unknown ref
fails the task before anything is created. Optional `settings.json` keys, all with defaults:

| Key                     | Default                                     | Meaning                                                                                                                                   |
| ----------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `worktree.root`         | `<workingDirectory>/.boof-runner-worktrees` | Where worktrees live (`<root>/<id>`, sidecar in `<root>/.meta`). Relative paths resolve against `workingDirectory`; `~/` expands to home. |
| `worktree.onDone`       | `"keep-branch"`                             | `keep-branch`: remove the directory, keep the branch. `keep`: keep the directory too. `delete`: remove directory and branch (loud log).   |
| `worktree.onFailure`    | `"keep"`                                    | `keep`, or `delete` (loud log). Stopped tasks always keep their work.                                                                     |
| `retries.transient`     | `2`                                         | Retries per step after a transient API error (5xx, 429, 529, overloaded, ECONNRESET, ETIMEDOUT, ...).                                     |
| `retries.backoffMs`     | `[30000, 120000]`                           | Delay before each retry; a stop request during the wait stops the task.                                                                   |
| `retries.idleTimeoutMs` | `1200000`                                   | A step that prints nothing for this long is killed and retried as transient.                                                              |

Nothing is deleted under the defaults. A done task's uncommitted leftovers never land on the
task branch: they are saved on `boof-runner/<id>--leftovers`. With `runs > 1`, each iteration
after the first sees the previous iteration's final observer and reviewer reports. See
[docs/boof-runner.md](docs/boof-runner.md) for details.

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

### Observer, verdicts and the fix loop

One model develops, a second **observes**, a third gives the **final review**. Only a
reviewer `APPROVE` lets a task finish as `done`.

- **Observer (optional).** Assign `settings.roles.observer` (`{ "tool", "model" }`, also
  settable in the Settings page; `(none)` disables it) or override it per task with
  `tools.observer` in the task frontmatter. It runs after the developer and sees the task
  prompt, the final plan and the diff against the worktree base.
- **Verdict protocol.** Observer and reviewer reports must end with exactly one line:
  `VERDICT: APPROVE`, `VERDICT: CHANGES_REQUESTED` (findings listed above it) or
  `VERDICT: REJECT` (not fixable in place). The last non-empty line must be the verdict
  (case-sensitive, trailing whitespace and markdown emphasis ignored); any other verdict
  line with a different verdict anywhere in the report makes it invalid, identical repeats
  are fine. A missing, malformed or conflicting verdict counts as not approved.
- **Gate and fix loop** (`settings.review.gate`, default `true`). On `CHANGES_REQUESTED`
  the developer re-runs in the same worktree to fix each real finding with a test or rebut
  it with evidence, then the same role re-checks. A reviewer fix is re-checked by the
  observer first. Each of observer and reviewer gets `settings.review.maxFixRounds` fix
  rounds (default `2`). `REJECT`, an invalid verdict or a spent budget fails the task with
  `review not approved: <role> <verdict>` (`INVALID` for a bad verdict); the worktree and
  branch are kept. With `gate: false` the observer still runs but verdicts are only
  recorded.
- **Diff cap.** Prompts inline the diff only up to `settings.review.maxInlineDiffBytes`
  (default `120000`); above that they get the `--stat` summary, the untracked-file list and
  a note to read it with `git diff <base-sha>`.

All keys are optional; existing `settings.json` and task files keep working.

```json
{
  "roles": { "observer": { "tool": "claude-code", "model": "sonnet" } },
  "review": { "gate": true, "maxFixRounds": 2, "maxInlineDiffBytes": 120000 }
}
```

For offline tests the `mock` tool takes a marker in the prompt:
`[[mock-verdicts observer=CHANGES_REQUESTED,APPROVE reviewer=APPROVE]]` (per role, one
verdict per round, last repeats; also `NONE`, `GARBLED`, `CONFLICT`). The marker must
sit on one line, the last complete marker wins, and unknown tokens throw.

## Security model

- The server binds 127.0.0.1 only and rejects requests whose Host header is not a loopback name. This blocks DNS-rebinding attacks from websites open in your browser.
- Anyone who can reach the API can create a task, and every task runs coding agents with permission prompts disabled inside your repository. Treat API access as equivalent to running code as your user.
- Task and command ids are validated as kebab-case before they touch the filesystem. Request bodies are schema-validated and size-limited (1 MB JSON, 25 MB attachments).
- Agents work in a git worktree on a `boof-runner/<id>` branch. Nothing is merged or pushed for you.
- Do not expose the port to other machines. Authenticated remote access is planned.

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
