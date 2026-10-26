# boof-runner — Agent Task Runner

> Installs the `boof-runner` command.

Boof Runner queues coding tasks and runs them through a disciplined **planner → developer → observer → reviewer** pipeline, driven by coding agents such as Claude Code and Codex. It is **local-first**: every task is a markdown file on disk, each task runs in its own git worktree, and nothing is merged or pushed for you. You drive it from a web UI, a desktop app, the command line, a REST API or MCP, so a person or another AI agent can submit work, answer the planner's questions and review the result.

- **Projects** — register any number of git repositories. Each has its own queue, plans, usage and settings overrides; one runner serves them all.
- **Plans and goals** — a plan is a versioned graph of goals with dependencies. Sync turns ready goals into tasks and keeps the tasks in line when a goal changes.
- **Pipeline** — planner, planner refinement, developer, optional observer, reviewer. The planner can park a task and ask you questions.
- **Review gate** — observer and reviewer end with a `VERDICT:` line; a fix loop sends findings back to the developer. Only a reviewer approval finishes a task.
- **Worktrees** — every task runs on its own branch `boof-runner/<task-id>`. Branches are kept; failed or stopped work is never discarded.
- **Web UI** — React and Vite over a Hono server, with live updates and agent output streaming.
- **Desktop app** — Electron wrapper that runs server, runner and UI in one window.
- **CLI** — headless `run`, `scan`, `project`, `plan`, `auth` and `mcp` commands, no web server needed.
- **REST API** — versioned `/api/v1` generated from one operations registry, with an OpenAPI 3.1 document, ETags, idempotency keys and paging.
- **MCP** — the same operations as 33 tools over stdio and Streamable HTTP (`/mcp`), plus resources and prompts.
- **Events and webhooks** — replayable server-sent events and HMAC-signed webhooks.
- **Security** — loopback by default; API keys with scopes, project restrictions and trust levels; Host guard, rate limit and audit log.

> Boof Runner runs agents with permission prompts disabled inside your repositories. Treat access to it like access to your shell. See [Security model](#security-model).

## Requirements

- **Node.js ≥ 22.22** or **Bun** (the code runs on both)
- **git** — the runner isolates each task in a git worktree, so every project's _working directory_ must be a git repository with at least one commit
- Optional CLIs detected at runtime via health checks: `claude-code`, `codex` (the `mock` tool covers offline use)

## Quick start

```bash
bun install          # or: npm install
npm run build        # build the web UI + the CLI bundle
npm run dev          # run from source (tsx): boots the web UI and the runner
```

Open the URL it prints (default <http://127.0.0.1:4319>). A fresh data root (`./data`) has **no projects**.

**First project.** Register a git repository in the UI (the project picker) or from the command line:

```bash
boof-runner project add /path/to/repo --default
```

**First task.** In the UI open the Tasks tab, add a task with a prompt and queue it, then switch the runner on with the toggle next to the project picker. Or run one prompt headless and watch it finish:

```bash
boof-runner run "Add a rate limiter to the API" --repo /path/to/repo
```

When the task is done, review the branch `boof-runner/<task-id>` in your repository and merge it yourself.

### Desktop app

```bash
npm run desktop      # build the UI + Electron bundle, then launch the window
```

The desktop app boots the same Hono server and runner in its main process and opens the UI in a native window. Its data root lives in the per-user app-data directory, so settings persist across launches.

On first launch it asks for the first project's **working directory** (a full-screen picker that opens a native folder dialog). The project is saved in the data root and never asked again; change the directory any time via the folder icon in the top-right header.

### Running the built CLI

```bash
node bin/dist/boof-runner.js          # after `npm run build`
boof-runner                      # after `npm install -g .`
```

### Headless CLI (no web server)

The runner can be driven entirely from the command line — no web UI required. All commands share `-d, --data <path>` (data root, or `$BOOF_RUNNER_DATA_ROOT`).

```bash
boof-runner project add /path/to/repo [--id <kebab>] [--name <text>] [--default]
boof-runner project list [--json]
boof-runner project remove <id> [--purge]   # archive; --purge deletes the project's data, never the repo

# Run a single prompt through the pipeline and stream progress.
# Exits non-zero if the task fails or parks for answers.
boof-runner run "Add a rate limiter to the API" --repo /path/to/repo   # registers the repo on first use
boof-runner run "Fix the flaky test" --project my-api                  # or name a registered project
boof-runner run --file task.md --repo /path/to/repo   # prompt from a file
boof-runner run --all                                 # drive the pending queue of every project
boof-runner run --all --project my-api                # ... or of one project

# SCAN MODE — turn a boof-seeded repo's unfinished units into tasks.
# Walks <repo> for goal.boof.xml files whose current status is not `done` and creates one task
# per unit, ordered by plan.boof.xml order and depends-on. Under the hood scan is
# `project add-or-get` + `plan import` + `plan sync`.
boof-runner scan /path/to/repo --dry-run   # list what it would create
boof-runner scan /path/to/repo             # create the tasks (registers the repo if needed)
boof-runner run --all -d ./data            # then drive them to completion
```

`run --repo <dir>` looks the project up by the real path of `<dir>` and registers it when unknown (the new id is printed). Without `--project` or `--repo`, `run` uses `settings.defaultProject` (set it with `project add <dir> --default`). Useful flags: `--base <ref>` (start the worktree from a branch or commit instead of HEAD), `--title <text>`, `--tool <id>` and `--model <name>` (force all roles to one tool, e.g. `--tool mock` for offline runs), `--runs <n>` (iterate a task N times), and for `scan` `--bump review|done`.

### Options (serve — the default command)

| Flag                | Env                     | Default   | Description                                               |
| ------------------- | ----------------------- | --------- | --------------------------------------------------------- |
| `-d, --data <path>` | `BOOF_RUNNER_DATA_ROOT` | `./data`  | Data root directory                                       |
| `-p, --port <n>`    | `BOOF_RUNNER_PORT`      | `4319`    | Web server port                                           |
| `--host <addr>`     | `BOOF_RUNNER_HOST`      | loopback  | Bind address; a non-loopback bind needs API keys          |
| `--tls-cert <file>` | —                       | —         | PEM certificate; with `--tls-key` the server speaks HTTPS |
| `--tls-key <file>`  | —                       | —         | PEM private key                                           |
| `--no-runner`       | —                       | runner on | Start the web server only                                 |
| `-h, --help`        | —                       | —         | Show help                                                 |

Run `boof-runner --help` for the full command reference.

### Worktrees, retention and retries

Each task runs in its own git worktree on branch `boof-runner/<id>`. Task frontmatter `base` (or `run --base <ref>`) starts it from a branch or commit instead of HEAD; an unknown ref fails the task before anything is created. Optional `settings.json` keys, all with defaults (a project can override `worktree`, `retries`, `review` and `roles` in its `project.json`; `workingDirectory` is the project's):

| Key                     | Default                                     | Meaning                                                                                                                                   |
| ----------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `worktree.root`         | `<workingDirectory>/.boof-runner-worktrees` | Where worktrees live (`<root>/<id>`, sidecar in `<root>/.meta`). Relative paths resolve against `workingDirectory`; `~/` expands to home. |
| `worktree.onDone`       | `"keep-branch"`                             | `keep-branch`: remove the directory, keep the branch. `keep`: keep the directory too. `delete`: remove directory and branch (loud log).   |
| `worktree.onFailure`    | `"keep"`                                    | `keep`, or `delete` (loud log). Stopped tasks always keep their work.                                                                     |
| `retries.transient`     | `2`                                         | Retries per step after a transient API error (5xx, 429, 529, overloaded, ECONNRESET, ETIMEDOUT, ...).                                     |
| `retries.backoffMs`     | `[30000, 120000]`                           | Delay before each retry; a stop request during the wait stops the task.                                                                   |
| `retries.idleTimeoutMs` | `1200000`                                   | A step that prints nothing for this long is killed and retried as transient.                                                              |

Nothing is deleted under the defaults. A done task's uncommitted leftovers never land on the task branch: they are saved on `boof-runner/<id>--leftovers`. With `runs > 1`, each iteration after the first sees the previous iteration's final observer and reviewer reports. See [docs/boof-runner.md](docs/boof-runner.md) for details.

### Install or update from source

```bash
bash scripts/install-or-update-boof-runner.sh
```

The script clones or fast-forwards the source checkout, installs dependencies, builds the web UI and CLI, and globally links the `boof-runner` command. Set `BOOF_RUNNER_DIR`, `BOOF_RUNNER_REPO`, or `BOOF_RUNNER_BRANCH` to override the source location. The default remote is `git@github.com:YaminT/boof.git`.

## Using the web UI

Pick a project at the top (or add one); every tab works on that project. The runner on/off toggle sits next to the project picker.

- **Tasks** — the queue with status filters (draft, pending, running, action, done, failed, archived) and drag-to-reorder priority. Open a task to edit its prompt, labels, runs, command template and attachments (images and PDFs), read the planner, developer, observer and reviewer reports, and watch the live agent output. Stop a running task or inject an extra instruction. Filter "Proposed by clients" to approve drafts that API clients created.
- **Plans** — create plans with goals and dependencies, edit them, import them from a repository's `goal.boof.xml` files or export them. **Approve** a draft plan to activate it, preview a sync (dry run), then **Sync to tasks**. Enable auto-sync to let the runner sync before it picks tasks.
- **Actions** — tasks parked because the planner has questions. Answer them and the task resumes.
- **Commands** — reusable instruction templates that any task can attach.
- **Settings** — concurrency and default project, tool health and model lists, role assignments (planner, developer, observer, reviewer), review gate, worktree, retries, token usage, API clients (create, rotate, revoke keys) and per-project overrides.

## CLI reference

```text
boof-runner [serve] [options]          Start the web UI + background runner (default)
boof-runner run <prompt> [options]     Enqueue a prompt and drive it to completion (headless)
boof-runner run --file <path> [...]    Same, reading the prompt from a file
boof-runner run --all [options]        Drive the pending queue of every project to completion
boof-runner scan <repo> [options]      Turn a repo's not-done goal.boof.xml units into tasks
boof-runner project <add|list|remove>  Manage projects (git repositories) of this data root
boof-runner plan <import|sync|export>  Import goal files into a plan, sync it to tasks, export XML
boof-runner auth <add|list|revoke|rotate>  Manage API clients for remote access
boof-runner mcp [options]              Serve boof over MCP on stdin/stdout
boof-runner --help                     Show help (also: <command> --help)
```

Common option: `-d, --data <path>` (data root, default `./data` or `$BOOF_RUNNER_DATA_ROOT`).

| Command   | Options                                                                                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serve`   | `-p, --port`, `--host`, `--tls-cert`, `--tls-key`, `--no-runner` (see [Options](#options-serve--the-default-command))                                                   |
| `run`     | `-f, --file`, `--all`, `--project <id>`, `--repo <dir>`, `--base <ref>`, `--title`, `--tool`, `--model`, `--runs <n>`                                                   |
| `scan`    | `--project <id>`, `--dry-run`, `--bump review\|done`, `--tool`, `--model`                                                                                               |
| `project` | `add <dir> [--id] [--name] [--default]`, `list [--json]`, `remove <id> [--purge]`                                                                                       |
| `plan`    | `import --project <id> [--plan <id>]`, `sync --project <id> --plan <id> [--dry-run] [--stop-running]`, `export --project <id> --plan <id> --out <dir>`                  |
| `auth`    | `add --name <text> --scopes <a,b,c> [--projects <id,id>\|*] [--trust trusted\|review] [--expires 30d] [--kind harness\|mcp\|cli]`, `list`, `revoke <id>`, `rotate <id>` |
| `mcp`     | `--client <id>`, `--project <id>`                                                                                                                                       |

Exit codes: 0 success; 1 a task failed, parked, nothing was actionable, or bad usage.

## Configuration

Settings live in `<data>/settings.json` (created on first run, schema version 2). Edit it in the UI, with `PUT /api/v1/settings`, or by hand; the `security` and `webhooks` keys are edited by hand or through their own operations. All keys except the schema version are optional.

| Key                  | Default                                                                                    | Meaning                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `runner.enabled`     | `false`                                                                                    | Whether the background runner picks tasks.                                                                  |
| `runner.concurrency` | `1`                                                                                        | Tasks in flight at once. At most one task per project runs at a time.                                       |
| `defaultProject`     | `null`                                                                                     | Project used by `run` without `--project` and by the legacy `/api/tasks` routes.                            |
| `roles`              | planner `claude-code`/`opus`, developer `codex`/`gpt-5.5`, reviewer `claude-code`/`sonnet` | `{ tool, model }` per role. Add `observer` to enable the observer step.                                     |
| `review`             | `gate: true`, `maxFixRounds: 2`, `maxInlineDiffBytes: 120000`                              | Verdict gate and fix loop (see [How it works](#how-it-works)).                                              |
| `worktree`           | `onDone: "keep-branch"`, `onFailure: "keep"`                                               | Worktree location and retention (see [Worktrees, retention and retries](#worktrees-retention-and-retries)). |
| `retries`            | `transient: 2`, `backoffMs: [30000, 120000]`                                               | Retry and stall handling.                                                                                   |
| `security`           | see [Security model](#security-model)                                                      | `auth.mode`, `allowedHosts`, `allowedProjectRoots`, `externalTasksRequireApproval`, `rateLimit`, `audit`.   |
| `mcp.enabled`        | `true`                                                                                     | `false` switches MCP off (`/mcp` answers 404, `boof-runner mcp` refuses to start).                          |
| `webhooks`           | none                                                                                       | Event subscriptions; manage them with the admin `/api/v1/webhooks` operations.                              |

A project can override `roles`, `review`, `worktree` and `retries` per key in its `project.json`.

### Data root layout

```text
<data>/
  settings.json          # schemaVersion 2: runner, roles, models, review, worktree, retries, security, mcp, webhooks
  commands/              # command templates, shared by all projects
  auth/  audit/          # API clients and the request audit log
  idempotency/           # stored responses of Idempotency-Key requests (24 h)
  events.jsonl           # global events (runner toggles)
  projects/
    <projectId>/
      project.json       # name, working directory, paused/archived, overrides
      tasks/             # drafts/ pending/ ongoing/ actions/ done/ failed/ archived/ assets/
      plans/             # <planId>.json
      events.jsonl       # structured events of this project
      usage.json         # token usage of this project
  migration-v2.log       # only after a migration from a v1 data root
```

A data root from before multi-project support is migrated automatically the first time any command touches it; task files, command templates, worktrees and branches are untouched. The migration refuses to run while a task is `ongoing` and the runner process is alive.

### Concurrency

`runner.concurrency` is how many tasks the runner may run at once. Whatever the value, **at most one task runs per project at a time**. With concurrency above 1, tasks of different projects overlap and share the machine's CPU, memory and API rate limits; raise it only when the projects are independent.

## Security model

- The server binds `127.0.0.1` by default and rejects requests whose Host header is not a loopback name or listed in `security.allowedHosts`. This blocks DNS-rebinding attacks.
- Anyone who can reach the API can create a task, and every task runs coding agents with permission prompts disabled inside your repository. Treat API access as equivalent to running code as your user.
- Ids are validated as kebab-case before they touch the filesystem. Request bodies are schema-validated and size-limited (1 MB JSON, 25 MB attachments).
- Agents work in a git worktree on a `boof-runner/<id>` branch. Nothing is merged or pushed for you.
- Do not expose the port to the public internet without keys and TLS.

### Remote access

A request from a loopback peer with no `Authorization` header is the trusted `local` principal (while `security.auth.mode` is `"local-trust"`, the default). Anything else needs an API key.

```bash
# 1. require keys everywhere: set in settings.json
#    "security": { "auth": { "mode": "required" }, "allowedHosts": ["boof.example.com"],
#                  "allowedProjectRoots": ["~/codes"] }
# 2. create a client (the key is printed once; scopes limit what it can do)
boof-runner auth add --name ci-bot --scopes tasks:read,tasks:write --expires 30d
# 3. bind beyond loopback; refused unless mode is "required" and a client exists
boof-runner --host 0.0.0.0 --tls-cert cert.pem --tls-key key.pem
```

- Clients may be restricted to some projects (`--projects a,b`): other projects answer `403 forbidden_project`. A client with `projects:write` may register a project only when its real path is under `security.allowedProjectRoots`, is a git work tree, is not inside the data root and is not `/` or the home directory.
- Call the API with `Authorization: Bearer boof_<client>_<secret>`. The browser UI asks for the key once per tab. The desktop app manages its own key.
- `boof-runner auth list | revoke <id> | rotate <id>` manage clients. Revoked and expired keys stop working within 5 seconds.
- **Keys are root-equivalent.** Scope them narrowly, set `--expires`, and keep the default `review` trust for anything you do not fully control: its tasks and plans land as drafts that a human approves in the UI. Use `--trust trusted` only for clients you would give your own shell.
- Without TLS, keys travel in clear text; the server warns when you bind a non-loopback address without `--tls-cert`/`--tls-key`. Tailscale or a reverse proxy are fine alternatives. Requests carrying `X-Forwarded-For` never get local trust.
- Every `/api` and `/mcp` call is appended to `<data>/audit/<day>.jsonl` (principal, action, status, timing, IP; never bodies, prompts or keys). Requests are rate limited per principal (`security.rateLimit`, default 600/min).

The full REST reference, error codes and webhooks are in [docs/api.md](docs/api.md).

## Connect AI agents

Give your agent one URL and an API key. The agent reads the guide, asks you for the details it needs and operates boof by itself.

- Hosted guide: `https://nodets.com/boof/harness.txt`
- Your own server serves the same guide without authentication at `<boof-host>/harness.txt` (also `/harness.md` and `/llms.txt`).

Tell the agent: _"Read https://nodets.com/boof/harness.txt and use it to operate my boof server."_ The guide covers connecting (REST or MCP), the concepts, every REST operation and step-by-step workflows. Its source is [docs/harness.md](docs/harness.md); the reference part is generated from the code (`npm run docs:gen`).

### MCP

Boof speaks the Model Context Protocol with the same scopes, trust and audit as REST. The tool list is in [docs/api.md](docs/api.md#mcp).

**Local agent (stdio).** The agent host starts `boof-runner mcp`; no server and no key are needed.

```bash
# one repository: the projectId argument is filled in and hidden
claude mcp add boof -- boof-runner mcp -d ~/.local/share/boof-runner/data --project pim
# everything the data root serves, limited to an API client's scopes and projects
claude mcp add boof -- boof-runner mcp -d ~/.local/share/boof-runner/data --client agent-1
```

Without `--client` the agent is the local admin principal, which only works while `security.auth.mode` is `local-trust`. The server writes logs to stderr only.

**Remote harness (HTTP).** Start `boof-runner serve` (with TLS and a key when it is not loopback) and point the client at `/mcp`:

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

The endpoint is stateless (no sessions); use `boof_wait_task` to follow a task.

## How it works

A task moves physically between status directories under `<data>/projects/<id>/tasks/`, kept in sync with its `status` frontmatter field:

```
drafts/ → pending/ → ongoing/ → done/
                  ↘ actions/ (awaiting your answers)  ↘ failed/
```

The runner polls the `pending/` directory of every active, non-paused project, picks the highest-priority task (ties: oldest `updated`, then project id), and runs **planner → planner-refinement → developer → observer (optional) → reviewer**, writing a report at every step. If the planner raises clarifying questions, the task parks in `actions/` and the runner moves on; you answer in the **Actions** tab and it resumes. Developer and reviewer questions are routed back to the planner via file and never reach you.

Plans add a layer above tasks: a plan's goals become tasks when you sync, and a later sync brings those tasks in line with changed goals (pending prompts are rewritten, running tasks get an instruction, finished goals get a follow-up task). When a plan task finishes, the goal's status is recorded in the plan.

Turn the runner on or off any time from the UI; it finishes the in-flight step gracefully.

### Observer, verdicts and the fix loop

One model develops, a second **observes**, a third gives the **final review**. Only a reviewer `APPROVE` lets a task finish as `done`.

- **Observer (optional).** Assign `settings.roles.observer` (`{ "tool", "model" }`, also settable in the Settings page; `(none)` disables it) or override it per task with `tools.observer` in the task frontmatter. It runs after the developer and sees the task prompt, the final plan and the diff against the worktree base.
- **Verdict protocol.** Observer and reviewer reports must end with exactly one line: `VERDICT: APPROVE`, `VERDICT: CHANGES_REQUESTED` (findings listed above it) or `VERDICT: REJECT` (not fixable in place). The last non-empty line must be the verdict (case-sensitive, trailing whitespace and markdown emphasis ignored); a conflicting verdict anywhere in the report makes it invalid. A missing, malformed or conflicting verdict counts as not approved.
- **Gate and fix loop** (`settings.review.gate`, default `true`). On `CHANGES_REQUESTED` the developer re-runs in the same worktree to fix each real finding with a test or rebut it with evidence, then the same role re-checks. A reviewer fix is re-checked by the observer first. Each of observer and reviewer gets `settings.review.maxFixRounds` fix rounds (default `2`). `REJECT`, an invalid verdict or a spent budget fails the task with `review not approved: <role> <verdict>`; the worktree and branch are kept. With `gate: false` the observer still runs but verdicts are only recorded.
- **Diff cap.** Prompts inline the diff only up to `settings.review.maxInlineDiffBytes` (default `120000`); above that they get the `--stat` summary, the untracked-file list and a note to read it with `git diff <base-sha>`.

```json
{
  "roles": { "observer": { "tool": "claude-code", "model": "sonnet" } },
  "review": { "gate": true, "maxFixRounds": 2, "maxInlineDiffBytes": 120000 }
}
```

For offline tests the `mock` tool takes a marker in the prompt: `[[mock-verdicts observer=CHANGES_REQUESTED,APPROVE reviewer=APPROVE]]` (per role, one verdict per round, last repeats; also `NONE`, `GARBLED`, `CONFLICT`).

## Project layout

```
packages/shared    task-file format, schemas, projects, plans, auth store, events, v1→v2 migration, lifecycle
packages/runner    tool adapters, git worktree isolation, plan sync, the pipeline engine
packages/api       operations registry (defineOp), services, OpenAPI generator
packages/mcp       MCP server (stdio + Streamable HTTP) generated from the registry
packages/web       Hono server: security chain, REST routes, SSE, webhooks, /mcp; React UI under packages/web/ui
packages/desktop   Electron app: boots the server + runner in-process, opens the UI window
bin/               the `boof-runner` CLI: scaffolds data, boots web, ensures a single runner
docs/              harness.md (guide for AI agents), api.md (REST and MCP), boof-runner.md (architecture)
scripts/           install script and the harness guide generator
```

The `@boof-runner/*` packages are consumed from source and bundled into a single self-contained CLI by tsup; the React UI is built by Vite and served by the Hono server.

For a deeper explanation of the architecture, see [docs/boof-runner.md](docs/boof-runner.md).

## Development

```bash
npm run dev          # boot from source (web + runner)
npm test             # full offline suite (unit + integration + web E2E, mock tool)
npm run typecheck    # tsc -b across all packages
npm run lint         # prettier --check
npm run format       # prettier --write
npm run build        # vite build (UI) + tsup bundle (CLI)
npm run docs:gen     # regenerate the REST reference in docs/harness.md and its embedded copy
```

All pipeline tests drive the **mock** tool, so CI never makes network calls or burns tokens. After changing an operation, run `UPDATE_OPENAPI=1 npx vitest run packages/api` and `npm run docs:gen`.

## License

Apache License 2.0. See [LICENSE](LICENSE).
