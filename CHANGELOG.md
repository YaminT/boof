# Changelog

## Unreleased

- Fix secret masking in assistant change previews, preserving commit SHAs and slash paths.
- Add the console assistant: free text in the bottom console goes to a concierge on claude-agent with boof's own MCP server under a narrow, review-trust principal. It creates drafts; deleting, archiving, queueing and changing others' work wait for your confirmation. Spend is recorded as `tool:concierge`. Without a compliant model, and in the desktop app, the console works as before and says why.
- Add the write-only `owlishAgentKey`, an api-only better-ccflare key that `claude-agent` processes receive instead of the admin client key. Gateway mode without it falls back to the project key or is refused.
- Refuse write-only secrets in inline `--input` JSON on the CLI (use `--input @file` or `--input @-`).
- Refuse secret-bearing webhook URLs in CLI arguments and inline `--input` JSON; use `--input @file` or `--input @-`.

### Fixed

- Applying a pending change reports a concurrent edit as `409 change_stale`, including when the operation itself answers `plan_version_conflict`, `task_modified` or `epic_modified`. The stored stamp is copied only into the `If-Match` field that matches the guard kind.
- A failure writing the `concierge:ask` audit line is logged and no longer replaces the turn.
- An assistant conversation id the caller owns, once it has been idle for `idleMinutes`, starts a fresh conversation. An id owned by someone else is still `404 not_found`.
- A failure while recording assistant spend no longer drops the conversation update, the audit line, or the turn. The failure is logged and written as `concierge:spend`.
- Applying a pending change copies the stored stale-guard stamp into `expectedUpdated` or `expectedVersion` when the operation accepts it, so the operation refuses a concurrent edit.

### Runner and agent workflow

- Add the opt-in `claude-agent` tool on the Claude Agent SDK: in-place steering of a `now` injection (with an optional model switch, and a kill-and-resume fallback), session resume and an SDK-reported cost estimate. It runs in bare mode with a per-project config folder and only the repo's permission rules. It runs through better-ccflare only when every pool account uses an API key, and otherwise with the project's own Anthropic API key; a task that cannot be authenticated does not start. It is not in the desktop app. Claude Code stays the default.

## 0.3.0 (2026-11-05)

### Fixes

- Handle CLI stop signals received during startup and release the runner guard cleanly.

### Internal package split

- Rename and move internal packages into the final workspace layout; user-facing behavior is unchanged.

### Projects

- Create projects in an existing directory, a new Git repository, or an automatically chosen directory under the configured projects root.
- Add a project brief that is included in agent prompts.
- Archive projects and restore or delete them from the archived-projects view.
- Configure project-specific role, review, worktree, retry, and budget overrides.
- Reject projects that point to the same Git repository, including linked worktrees.
- Prune stale worktrees when a project is added or unarchived.

### Plans and goals

- Import, export, edit, reorder, and sync project plans and their goals from the UI, CLI, REST API, or MCP.
- Sync active plans into tasks for goals whose dependencies are complete, with plan changes reflected in pending work.
- Track plan versions and goal history, and use conditional writes to avoid overwriting newer edits.
- Approve plans before synced work can run; review-trust clients create drafts that require human activation.
- Preserve plan approval when importing or activating plans, including plans created before approval tracking.
- Carry a goal's epic assignment into its task and keep it when a plan import omits the assignment.
- Import repository goals with normalized, unique goal paths.

### Tasks, epics, and subtasks

- Group tasks into optional epics and one-level subtasks, with row chips, a task-page hierarchy and subtasks list, and derived progress in task views and agent prompts.
- Filter and group task lists by epic, use palette actions to move tasks or create subtasks, and manage epics from the task list.
- Delete epics with safe detachment of their tasks; task and hierarchy changes are serialized across processes.
- See open-subtask warnings when queuing a parent task; hierarchy does not change queue scheduling.
- Edit tasks with optimistic concurrency checks and preserve user edits made while a task is running.
- Keep task logs and reports readable when prompts contain section-like headings.
- Record run and step timings, attempt usage, and a closing outcome entry.

### Runner and agent workflow

- An empty Codex model uses the CLI built-in default; Boof ignores `config.toml` model by default and honors it when `runner.inheritMcpServers` is enabled. Existing saved models remain unchanged.
- Route planner questions from developer, observer, and reviewer steps back to the role that asked, and park tasks when the planner needs user input.
- Retry transient tool failures in the same worktree with backoff, while recording each attempt and checking budgets before retries.
- Pass large Codex and OpenCode prompts through stdin to avoid command-line length limits.
- Limit agent environment variables to an allowlist and avoid loading user MCP configuration by default; opt in to inherited MCP servers through settings.
- Show tool health, model sources, and usage, with health and model reads reporting cached probes and explicit endpoints refreshing them.
- Preserve work after interrupted runs and reap verified orphaned agent processes where supported; Windows orphan reaping is experimental.

### Diff review and stopped status

- Inspect task diffs, including untracked files, commits, and uncommitted work in a retained worktree.
- Retry stopped or failed tasks, preserve their worktrees, and record stopped as a distinct outcome.

### Web UI and redesign phases

- Replace the previous interface with a redesigned navigation shell, task overview, grouped task list, command palette, and task detail tabs for runs, changes, and questions.
- Deliver the redesign through focused phases covering navigation and task views, simple and expanded modes, settings and plans, and the final styling and accessibility pass.
- Navigate with path-based URLs, including under a reverse-proxy prefix, and redirect old hash-based links.
- Use the Plans screen, goal editor and history panel, and a global Inbox for questions that need answers.
- Reorder tasks and goals with pointer or keyboard controls, with focus-managed dialogs and accessible status updates.
- Edit settings in focused pages for agents, budgets, API keys, automation, and projects.
- Keep unsaved settings and task edits when live updates arrive, and offer reload or overwrite when a task has changed elsewhere.
- Manage API client scopes, rotate and revoke keys, configure command templates, and manage webhook delivery from the UI.
- Open tasks from plans and return to the originating plan; keep the URL aligned when projects or tasks change.
- Load major screens on first use to reduce the initial UI load.
- Use a persistent bottom console for palette actions and slash commands, with command history and confirmations for destructive actions.
- Switch each screen between remembered simple and expanded views; improve contrast and keyboard focus states, and remove the legacy stylesheet.

### REST API v1

- Add the versioned `/api/v1` API with an OpenAPI document and operations shared by the REST routes, MCP tools, and generated CLI.
- Expose project, plan, goal, task, epic, settings, client, command-template, usage, runner, and webhook operations.
- Add project-scoped task pagination, optional task-log retrieval, live log streaming, task diffs, and version-based conditional writes.
- Add idempotency keys for project, plan, and task creation, including safe replay of concurrent identical requests.
- Use a shared operation registry to generate `boof-runner <area> <verb>` commands with consistent argument handling and exit codes.

### MCP

- Generate MCP tools from the operation registry for stdio and Streamable HTTP; tools use the same validation, permissions, and audit trail as REST.
- Expose each registered operation to MCP callers according to their scopes, with administrative tools reserved for administrators.
- Add `boof-runner mcp --admin` for a local stdio host that needs administrator access; keyless MCP defaults to a review-trust identity.
- Record operation calls made through stdio MCP and the generated CLI in the shared audit log.

### Events and webhooks

- Stream typed events over server-sent events, replay from cursors, and end streams when their authorization is revoked.
- Deliver signed webhooks for task, plan, and runner events, with event and project filters, retries, and dead-letter records.
- Provide webhook editing, including enable, disable, URL, event, and project updates.

### Owlish account pooling and Accounts tab

- Configure Owlish integration with the better-ccflare account pool through `settings.owlish` (`url`, `healthGate`) and a write-only client key; route Claude, Codex, and OpenCode through the gateway when their tools support pooling.
- Pause selection of pool-routed work when the fail-safe health gate is closed, and wait in place up to `retries.poolWaitMs` when a running pipeline reaches an unavailable pool.
- List and manage pool accounts through `boof-runner accounts list|pause|resume|priority|thresholds|health` and the `accounts.*` operations; review-trust and keyless clients may read pool status but cannot change accounts or gateway settings.
- Account pooling by better-ccflare.
- Add an Accounts settings tab to inspect pool health and manage account pause state, priority, and thresholds.

### Security and access control

- Authenticate API requests with scoped client keys, trust levels, project restrictions, expiry, rotation, and revocation.
- Limit review-trust clients to drafts and their own eligible work; prevent them from activating plans, administering projects, or changing work they do not own.
- Prevent restricted clients from widening project, expiry, settings, or webhook access beyond their own reach.
- Apply Host and Origin checks, same-site fetch checks, JSON content-type requirements, security headers, and rate limits to protect the local API.
- Rate-limit failed authentication attempts and cache `/healthz`; keep successful key requests out of the failed-authentication bucket.
- Keep webhook signing secrets outside settings files, restrict their file permissions, and never return secrets after creation.
- Block webhook targets resolving to local or reserved networks, pin delivery connections to checked DNS addresses, and do not follow redirects.
- Restrict remote worktree roots to allowed project roots and avoid exposing hidden API clients through list or lookup results.
- Audit principals, actions, outcomes, and forwarded client addresses without recording prompts, request arguments, or keys.

### Budgets and usage

- Set daily spending limits globally, per project, or per tool, and pause new work when a limit is reached.
- View today's spend and budget status in the UI and through the API.
- Track token usage per attempt and tool; represent unknown costs as unknown rather than zero.
- Include usage from failed and steered attempts in task records and budget accounting.

### Steering

- Inject new instructions for the next step or interrupt and steer the active step where the agent tool supports it.
- Keep injected instructions across retries and later runs, and show them in task details.

### CLI, server service, and desktop

- Add project, plan, task, and epic commands, including project creation modes and hierarchy-aware task runs.
- Add `--version`; unknown commands now return an error instead of starting the server.
- Install, inspect, uninstall, and view logs for a system service; preserve configured options when reinstalling it.
- Install and update the server service on a headless Linux host, with systemd and remote access setup guidance.
- Install and safely update a headless server, with a deployment runbook and reverse-proxy guidance.
- Host the UI under a reverse-proxy path prefix using relative URLs without a build option.
- Configure service secrets through an environment file and set up remote access with a guided tunnel flow.
- Keep one runner and one webhook dispatcher active per data root with cross-process guards; webhook delivery uses stable delivery ids so receivers can identify retries.
- Identify runner processes by boot and start identity when available, and serialize task and epic hierarchy changes across processes.
- Upgrade the TypeScript toolchain to 7.0.2.
- Shut down the runner gracefully, stop tasks starting during shutdown, and recover interrupted tasks on restart.
- Report app version and runner state from the desktop server, keep navigation on the app origin, and shut down the engine cleanly when the app quits.
- Build desktop release installers from versioned release tags; npm-only installs are supported.

### Breaking changes and upgrade notes

- New Codex roles no longer name a model; Codex uses its built-in default, or `config.toml` when `runner.inheritMcpServers` is enabled. Saved models are unchanged.
- `GET /health` and `GET /models` report the last probe result; run `POST /health/check` or `POST /models/refresh` to start a probe.
- Keyless loopback access to `/mcp` now uses the restricted `local-mcp` review-trust principal; use an authorized key or stdio `--admin` when administrator access is required.
- Review-trust API clients have narrower write permissions, including restrictions on task ownership, project administration, plan activation, and hierarchy detachment.
- UI routes use path URLs instead of hash URLs; old hash links redirect to the path-based route.
- Deleting a task with subtasks or an epic with tasks requires `detach=true`, which clears the child relationships.
- `If-Match` accepts one ETag only; comma-separated ETag lists return `400`.
- Webhook secrets are stored separately from `settings.json`; older runner versions cannot read a migrated settings file with inline webhook secrets removed.
- Webhook delivery now blocks private, loopback, and reserved destinations unless explicitly allowed in `security.allowedPrivateWebhookHosts`.
- The data root uses schema version 2 and projects; do not run an older version that drops project or task hierarchy fields against the upgraded data root.
- Optional `settings.owlish`, write-only `owlishApiKey`, and `retries.poolWaitMs` settings add better-ccflare account pooling; existing settings files need no migration.
