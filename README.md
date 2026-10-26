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
- **Many projects, one runner** — register any number of git repositories; each has its own
  task queue, usage and setting overrides, and one runner serves them all in priority order.
- **Desktop app** (Electron) — runs the server, runner, and UI in one window; remembers
  your projects between launches.
- **Prompt attachments** — drop images or PDFs onto a task's prompt; the runner exposes
  them to the agents for additional context.

> Single-user, local only. No cloud, no OS boot service. See [Security model](#security-model).

## Requirements

- **Node.js ≥ 20** or **Bun** (the code runs on both)
- **git** — the runner isolates each task in a git worktree, so every project's
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

On first run Boof Runner scaffolds the data root (`./data` by default) with a `commands/`
folder, an empty `projects/` folder and `settings.json`. A fresh data root has **no projects**:
the UI asks you to add one, or run `boof-runner project add <repo>`.

### Data root layout

```text
<data>/
  settings.json          # global: schemaVersion 2, runner, roles, models, review, worktree, retries, defaultProject, security
  commands/              # command templates, shared by all projects
  auth/  audit/          # API clients and the request audit log
  projects/
    <projectId>/
      project.json       # name, working directory, paused/archived, overrides
      tasks/             # drafts/ pending/ ongoing/ actions/ done/ failed/ archived/ assets/
      usage.json         # token usage of this project
  migration-v2.log       # only after a migration (see below)
```

A project is a git repository plus its own queue. `project.json` may override the global
`roles`, `review`, `worktree` and `retries` per key (an unset key inherits the global value);
it also holds `defaultBase` (the base ref for tasks that do not set one) and `paused`. The
runner skips paused and archived projects.

### Upgrading a v1 data root

A data root from before multi-project support (no `schemaVersion` in `settings.json`) is
migrated automatically the first time any command touches it (`serve`, `run`, `scan`,
`project`, the desktop app): `tasks/` and `usage.json` move into `projects/default/`, the old
`workingDirectory` becomes the `default` project's working directory, `settings.json` is
rewritten as v2 with `defaultProject: "default"`, and what moved is written to
`migration-v2.log`. Task files, command templates, worktrees and branches are untouched.
The migration refuses to run while a task is `ongoing` and the runner process is alive: stop
the runner and start again. It is idempotent and finishes by itself if a previous run was
interrupted.

The old unversioned routes (`/api/projects/…`, and `/api/tasks…` as aliases of the default
project) keep working for one release and answer with `Deprecation: true` and a `Sunset`
header; use `/api/v1/…` instead. The v1 API, its OpenAPI document (`GET /api/v1/openapi.json`),
events (SSE and signed webhooks) and curl examples are in [docs/api.md](docs/api.md).

### Desktop app

```bash
npm run desktop      # build the UI + Electron bundle, then launch the window
```

The desktop app boots the same Hono server and runner in its main process and opens the
UI in a native window. Its data root lives in the per-user app-data directory, so settings
persist across launches.

On first launch it asks for the first project's **working directory** (a full-screen picker
that opens a native folder dialog). The project is saved in the data root and never asked
again; change the directory any time via the folder icon in the top-right header.

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
boof-runner project add /path/to/repo [--id <kebab>] [--name <text>] [--default]
boof-runner project list [--json]
boof-runner project remove <id> [--purge]   # archive; --purge deletes the project's data, never the repo

boof-runner run "Add a rate limiter to the API" --repo /path/to/repo   # registers the repo on first use
boof-runner run "Fix the flaky test" --project my-api                  # or name a registered project
boof-runner run --file task.md --repo /path/to/repo   # prompt from a file
boof-runner run --all                                 # drive the pending queue of every project
boof-runner run --all --project my-api                # ... or of one project

# SCAN MODE — turn a boof-seeded repo's unfinished units into tasks.
# Walks <repo> for goal.boof.xml files whose current status is not `done`,
# creating one task per unit (ordered by plan.boof.xml order + depends-on, so a
# unit's dependencies run first). Each task instructs the developer to implement
# the unit strictly from its goal.boof.xml, TDD; on success the runner appends a
# <version> to that goal file bumping its status. Under the hood scan is
# `project add-or-get` + `plan import` + `plan sync` (see "Plans" below).
boof-runner scan /path/to/repo --dry-run   # list what it would create
boof-runner scan /path/to/repo             # create the tasks (registers the repo if needed)
boof-runner run --all -d ./data            # then drive them to completion
```

`run --repo <dir>` looks the project up by the real path of `<dir>` and registers it when
unknown (the new id is printed); a second call with the same directory reuses it. Without
`--project` or `--repo`, `run` uses `settings.defaultProject` (set it with
`project add <dir> --default`). `scan <repo>` does the same lookup; `--project <id>` must name
the project of that repo. Neither command writes a working directory to `settings.json`; the
only global change is `runner.enabled = true`, which is logged.

Useful flags: `--project <id>` / `--repo <dir>` (see above; a git repo enables worktree
isolation), `--base <ref>` (branch or commit the task's worktree
starts from instead of HEAD), `--title <text>` (task title, default the first line of
the prompt), `--tool <id>`/`--model <name>` (force all roles to
one tool, e.g. `--tool mock` for offline runs), `--runs <n>` (iterate a task N times),
and, for `scan`, `--bump review|done` (status recorded on success, default `done`).

`scan`/`run` are **universal**: nothing about any specific project is hardcoded — the
target repo is always taken from the argument.

### Plans

A plan is a stored, versioned DAG of goals (units of work) for one project, kept in
`projects/<id>/plans/<planId>.json`. A harness, the REST API or an import from a repo's
`plan.boof.xml` / `goal.boof.xml` files creates it; boof turns its goals into tasks and keeps
those tasks in line when a goal changes, then records the goal's status when the task finishes.

```bash
boof-runner plan import --project my-api              # repo XML -> plan "repo" (merges on re-run)
boof-runner plan sync   --project my-api --plan repo   # goals -> tasks (--dry-run to preview)
boof-runner plan export --project my-api --plan repo --out ./xml   # plan + goal XML files
```

REST (scopes `plans:read` / `plans:write`, project restriction applies): `GET/POST
/api/projects/:pid/plans`, `GET/PUT /plans/:planId`, `PUT /plans/:planId/goals` (replace the
DAG), `PUT/DELETE /plans/:planId/goals/:goalId`, `POST /plans/:planId/reorder`, `POST
/plans/:planId/goals/:goalId/status`, `POST /plans/import`, `GET /plans/:planId/export` and
`POST /plans/:planId/sync` (`{ "dryRun": true }`). Writes are conditional: send `If-Match: "<version>"`
(or `expectedVersion` in the body); a stale version gets `409 plan_version_conflict` with
`details.currentVersion`. Clients with `review` trust create `draft` plans, cannot activate or
edit an active plan, and sync of a draft plan is `409 plan_not_active`.

See `docs/boof-runner.md` for the goal model, the sync rules and the status write-back.

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

Run `boof-runner --help` for the full command reference (`serve`, `run`, `scan`, `project`, `auth`).

### Worktrees, retention and retries

Each task runs in its own git worktree on branch `boof-runner/<id>`. Task frontmatter `base`
(or `run --base <ref>`) starts it from a branch or commit instead of HEAD; an unknown ref
fails the task before anything is created. Optional `settings.json` keys, all with defaults (a project can override `worktree`, `retries`, `review` and `roles` in its `project.json`; `workingDirectory` is the project's):

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

A task moves physically between status directories under `<data>/projects/<id>/tasks/`, kept
in sync with its `status` frontmatter field:

```
drafts/ → pending/ → ongoing/ → done/
                  ↘ actions/ (awaiting your answers)  ↘ failed/
```

The runner polls the `pending/` directory of every active, non-paused project, picks the
highest-priority task (ties: oldest `updated`, then project id), and runs
**planner → planner-refinement → developer → reviewer**, writing a report at every step.
If the planner raises clarifying questions, the task parks in `actions/` and the runner
moves on; you answer in the **Actions** tab and it resumes. Developer/reviewer questions
are routed back to the planner via file — never surfaced to you.

Turn the runner on/off any time from the UI; it finishes the in-flight step gracefully.

#### Concurrency

`settings.runner.concurrency` (default `1`) is how many tasks the runner may run at once.
Whatever the value, **at most one task runs per project at a time**: the worktrees of one
repository are created one after another. With concurrency above 1, tasks of different
projects overlap. Each running task starts its own agent CLIs, so they share the machine's CPU
and memory and your API rate limits (more 429/overloaded retries, slower individual tasks);
raise it only when the projects are independent and the machine and quotas can carry it. Edit
it in `settings.json` or with `PUT /api/settings {"runner":{"concurrency":2}}`.

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

## Connect an agent over MCP

Boof speaks the Model Context Protocol, so Claude Code, Codex or a harness built on the Claude API can register projects, submit plans, queue tasks and answer parked questions with the same rules as the REST API (same scopes, trust and audit). The tool list is in [docs/api.md](docs/api.md#mcp).

**Local agent (stdio).** The agent host starts `boof-runner mcp`; no server and no key are needed.

```bash
# one repository: the projectId argument is filled in and hidden
claude mcp add boof -- boof-runner mcp -d ~/.local/share/boof-runner/data --project pim
# everything the data root serves, limited to an API client's scopes and projects
claude mcp add boof -- boof-runner mcp -d ~/.local/share/boof-runner/data --client agent-1
```

Without `--client` the agent is the local admin principal, which only works while `security.auth.mode` is `local-trust`; with `"required"` the command refuses to start. Create a narrow client first with `boof-runner auth add --name agent-1 --scopes projects:read,plans:write,tasks:read,tasks:write` (the key is not needed for stdio). The server writes logs to stderr only.

**Remote harness (HTTP).** Start `boof-runner serve` (with TLS and a key when it is not loopback, see "Remote access") and point the client at `/mcp`:

```bash
claude mcp add --transport http boof https://boof.example.com/mcp \
  --header "Authorization: Bearer boof_<client>_<secret>"
```

or in a JSON config (`.mcp.json`):

```json
{
  "mcpServers": {
    "boof": {
      "type": "http",
      "url": "https://boof.example.com/mcp",
      "headers": { "Authorization": "Bearer boof_<client>_<secret>" }
    }
  }
}
```

A client with `plans:write,tasks:read` can submit and change plans but cannot stop tasks or change settings. Clients with the default `review` trust only create `draft` tasks that a human approves. The endpoint is stateless (no sessions); use `boof_wait_task` to follow a task. Set `settings.mcp.enabled` to `false` to switch MCP off.

## Security model

- The server binds 127.0.0.1 by default and rejects requests whose Host header is not a loopback name. This blocks DNS-rebinding attacks from websites open in your browser.
- Anyone who can reach the API can create a task, and every task runs coding agents with permission prompts disabled inside your repository. Treat API access as equivalent to running code as your user.
- Task, command and project ids are validated as kebab-case before they touch the filesystem. Request bodies are schema-validated and size-limited (1 MB JSON, 25 MB attachments).
- Agents work in a git worktree on a `boof-runner/<id>` branch. Nothing is merged or pushed for you.
- Do not expose the port to the public internet. For other machines, use the remote access setup below.

### Remote access

Loopback use needs no setup: a request from a loopback peer with no `Authorization` header is the trusted `local` principal. Anything else needs an API key.

```bash
# 1. require keys everywhere: set in settings.json
#    "security": { "auth": { "mode": "required" } }
# 2. create a client (the key is printed once; scopes limit what it can do)
boof-runner auth add --name ci-bot --scopes tasks:read,tasks:write --expires 30d
# 3. bind beyond loopback; refused unless mode is "required" and a client exists
boof-runner --host 0.0.0.0 --tls-cert cert.pem --tls-key key.pem
```

- Clients may be restricted to some projects (`--projects a,b`): other projects answer `403 forbidden_project`. A client with `projects:write` may register a project only when its real path is under `security.allowedProjectRoots` (`~` expands), is a git work tree, is not inside the data root and is not `/` or the home directory; otherwise `403 project_root_not_allowed`. With no allowed roots only the local principal can add projects.
- Call the API with `Authorization: Bearer boof_<client>_<secret>`. The browser UI asks for the key once per tab (kept in `sessionStorage`). The desktop app manages its own key.
- `boof-runner auth list | revoke <id> | rotate <id>` manage clients. Revoked and expired keys stop working within 5 seconds (immediately for changes made through the API).
- **Keys are root-equivalent.** A client that can create and queue tasks can run code as you. Scope keys narrowly (`tasks:read` for dashboards), set `--expires`, and keep the default `review` trust for anything you do not fully control: its tasks land in `draft` labelled `external:<client>`, and a human approves them in the UI (Tasks, filter "Proposed by clients"). Use `--trust trusted` only for clients you would give your own shell.
- Without TLS, keys travel in clear text; the server warns when you bind a non-loopback address without `--tls-cert`/`--tls-key`. Tailscale or a reverse proxy are fine alternatives. Requests carrying `X-Forwarded-For` never get local trust.
- Every `/api` call is appended to `<data>/audit/<day>.jsonl` (principal, action, status, timing, IP; never bodies, prompts or keys). Files older than `security.audit.retentionDays` (default 90) are pruned at start. Requests are rate limited per principal (`security.rateLimit`, default 600/min, 30/min for attachments).
- Tasks submitted by a client carry a `## Provenance` note in the agent prompt telling it to treat out-of-repo instructions as out of scope. This is advisory; the real controls are trust level, worktree isolation and the never-merge default.

## Project layout

```
packages/shared    task-file format, schemas, project registry, v1→v2 migration, lifecycle state machine, atomic store
packages/mcp       MCP server (stdio + Streamable HTTP) generated from the operations registry
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
