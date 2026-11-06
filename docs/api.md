# boof-runner REST API (v1)

The API is generated from one operations registry (`packages/heart-server`), so REST, the MCP tools
(see "MCP" below) and the CLI commands (`boof-runner <area> <verb>`) stay identical. The exceptions:
attachment upload and download are not MCP tools, and the gaps of the web UI are listed in
`packages/facedisk/ui/src/op-coverage.ts`. The machine-readable contract is the OpenAPI 3.1 document at
`GET /api/v1/openapi.json` (a sorted copy is committed as `packages/heart-server/openapi/openapi.json`).
Generate a client from it, or use the examples below.

**Using an AI agent?** Point it at `<boof-host>/harness.txt` (public, no key; also `/harness.md` and `/llms.txt`), or `https://nodets.com/boof/harness.txt`. That guide, [harness.md](harness.md), holds a complete generated reference of every operation below.

Base URL: `http://127.0.0.1:4319/api/v1` (default bind). Every operation has an id
(`projects.create`), a scope, JSON input and JSON output.

## Authentication and scopes

- Loopback peers are trusted as the local user when `security.auth.mode` is `local-trust` (the
  default). Anything else needs `Authorization: Bearer boof_...`.
- **Browser requests.** `/api/*` and `/mcp` reject a request whose `Origin` (host and port) is not the request's own `Host` or a `security.allowedHosts` entry. An entry without a port matches only the default port of the Origin's scheme (80 for http, 443 for https); an entry with a port matches that port. Such a request is refused with `403 origin_not_allowed` (`Origin: null` too), and so is any browser request with `Sec-Fetch-Site: cross-site`. A JSON operation with a body needs `Content-Type: application/json` (`415 unsupported_media_type`). Together these stop a web page from driving the local principal with a "simple" cross-site request. The Host guard (`421`) is a DNS-rebinding defence, not a CSRF defence.
- Create a key (printed once) with the CLI or `POST /auth/clients`:

  ```bash
  boof-runner auth add --name harness \
    --scopes projects:write,projects:read,plans:write,plans:read,tasks:write,tasks:read \
    --trust trusted
  export BOOF=boof_xxx_yyy   # the printed key
  ```

- Scopes: `projects:read|write`, `plans:read|write`, `tasks:read|write|control`,
  `settings:read|write`, `runner:control`, `auth:admin`, `admin` (everything). Each operation lists
  its scope in the OpenAPI document (`x-boof-scope`).
- Command templates are global: `POST/PUT/DELETE /commands` need `settings:write` (listing needs
  `tasks:read`). Command templates can be written only by trusted clients with access to every
  project; grant `settings:write` to trusted clients only, because `PUT /settings` does not check
  trust yet. Renaming or deleting a template rewrites tasks in every project, so a `review`-trust
  or project-restricted client gets `403 forbidden_trust` on template writes even when it holds
  the scope. A rename repoints the tasks that can still run (draft, pending, action, stopped, failed) under each task's lock; running tasks are left alone (they keep their copy of the instructions): `PUT /commands/{id}` then lists their ids in `skippedTasks`. Done and archived tasks are not touched, since they record what they ran with. A task that keeps an id whose template is gone has the id cleared (its copied instructions stay) when it leaves running or is retried or unarchived.
- A client may be restricted to some projects. Touching another project is
  `403 forbidden_project`; project lists are filtered.
- **Trust.** A client with `trust: review` (the default for new clients) creates `draft` tasks
  and plans, cannot queue tasks or activate plans, and may stop or inject into only the tasks it
  created (`stopRunning` on plan routes likewise stops only its own tasks and leaves the rest
  running; likewise it may set back to `draft` only a plan it created, and removing a goal archives only its own tasks); a human approves in the UI. A `trusted` client may queue directly.
  A client created through `POST /auth/clients` never gets scopes, trust, projects or an expiry
  its creator lacks; a restricted creator's projects and expiry are inherited when omitted.
  Rotating or revoking a client is capped the same way: a client with scopes, trust, projects
  or an expiry beyond the caller's is refused (`403 forbidden_scope`, `forbidden_trust` or
  `forbidden_project`), and `GET /auth/clients` lists only clients the caller may manage plus
  itself. A client may always rotate or revoke itself. An `auth:admin` key manages only clients
  within its own reach (scopes, trust, projects and expiry); the local principal and an
  unrestricted, non-expiring trusted admin key manage every client.
- Registering a project as an API client needs the directory (for `path.mode` `new`: the
  directory it will become) to be inside `security.allowedProjectRoots` (settings.json); `auto`
  needs `settings.projectsRoot` itself inside an allowed root. Allowed roots must be absolute
  (or start with `~/`); a relative entry matches nothing. A `new` project must be a folder
  below an allowed root, never the root itself.
- `GET /api/v1/openapi.json` needs any valid principal.
- `GET /api/v1/whoami` (MCP `boof_whoami`) needs no scope: it returns `{ principal: { kind, id, name, trust, scopes[], projects, expiresAt? }, server: { version, authMode, mcpEnabled } }`. Call it first to learn what a key may do.

## better-ccflare account pool

**Account pooling by [better-ccflare](https://github.com/tombii/better-ccflare) (MIT, © 2025 snipeship & tombii), a fork of ccflare by snipeship.** Boof calls its optional gateway over HTTP. Boof never handles provider credentials. Sign-in and adding accounts happen in the better-ccflare dashboard.

Set `settings.owlish` to an object with `url` and optional `healthGate` (`pause`, `warn` or `off`; default `pause`). If it is absent, the pool is `absent` and no health gate applies. With `pause`, selection of tasks using a pool-capable tool pauses if the configured gateway is unhealthy, degraded or unreachable; the visible reason is included in runner pool status. `warn` reports without blocking, and `off` disables the gate. A running task waits in place for up to `retries.poolWaitMs` (default 30 minutes) between steps; it remains running during that wait.

Gateway URLs must use HTTPS except for loopback hosts (`localhost`, `localhost.`, `127.0.0.0/8`, or `[::1]`). Credentials, query strings and fragments are rejected.

The optional client key can be set once using `settings.update` input `owlishApiKey`, which is write-only, or supplied as `BOOF_OWLISH_API_KEY` (environment takes precedence). The stored file is `<data>/owlish/secrets.json`, mode 0600. The setting response does not return the key. `settings.update` also takes the write-only `owlishAgentKey` (env `BOOF_OWLISH_AGENT_KEY`): an api-only better-ccflare key that only `claude-agent` processes receive, stored in the same file and never returned; `accounts.health` shows only its source as `agentKeySource` (`file`, `env` or null). The CLI takes either key only through `--input @file.json` or `--input @-`; inline `--input` JSON that carries a write-only field is refused. The generated CLI commands are `boof-runner accounts list|pause|resume|priority|thresholds|health`; their exact flags are shown by `--help`. `accounts.health` accepts optional `refresh=true` to bypass its 10-second cache for an explicit check; concurrent forced checks share one gateway request. Reads use `settings:read`. Account mutations and gateway configuration use `settings:write` and require a trusted, project-unrestricted principal; `review-trust` and `local-mcp` cannot perform these changes.

Routed agents receive the gateway key in their environment and can call ccflare `/api/*` endpoints directly, outside boof's account-operation authorization. See [Agents are not sandboxed](boof-runner.md#agents-are-not-sandboxed) and the [agent-containment goal](superpowers/specs/2026-10-29-boof-roadmap.md).

### claude-agent and the compliance gate

The opt-in `claude-agent` tool (Claude Agent SDK) may use the gateway only when every account in it, paused ones included, is an API-key provider with no refresh token. Anthropic allows the Agent SDK only with API-key authentication, so subscription (OAuth) accounts stay on `claude-code`. The check needs a better-ccflare **admin** client key; an api-only key gets HTTP 401 and keeps the gate closed. The admin key stays inside boof. The gateway is usable for `claude-agent` only when a distinct api-only `owlishAgentKey` is also set; that key is what the agent process receives. Without it boof skips eligibility checking and immediately falls back to the project key or refuses. A network failure, timeout or 5xx while checking eligibility waits (pending at selection; a running step waits up to `retries.poolWaitMs`); a 401/403, subscription account or malformed answer refuses or falls back. Pool-routed claude-code, codex and opencode continue to receive the admin client key as before; only claude-agent gets the separate agent key. See [The claude-agent tool](boof-runner.md#the-claude-agent-tool) for the full rules, bare mode, the per-project config folder and the known limits.

- `accounts.agentSdk` (`GET /api/v1/accounts/agent-sdk`, MCP `boof_get_agent_sdk_eligibility`, CLI `boof-runner accounts agent-sdk`): scope `settings:read`; input `{ refresh? }`; returns `{ gateway: "absent" | "checked", allowed, reason, blocking: [{ id, name, provider, why }], checkedAt }`. `why` is `subscription`, `oauth-token` or `unknown-type`. With no `settings.owlish` it answers `gateway: "absent"`, `allowed: false` and makes no request.
- `projects.update` input `anthropicApiKey` (`string | null`): the project's own Anthropic API key, write-only. It is stored in `<data>/owlish/project-keys.json` (mode 0600), never returned, and `null` removes it. Only `sk-ant-api…` keys match; OAuth (`sk-ant-oat…`) and admin (`sk-ant-admin…`) keys give 400 without echoing the value. A `review-trust` or `local-mcp` principal gets 403 `forbidden_trust`. `projects.get` and `projects.list` show only `anthropicApiKeySet: boolean`, and `claudeAgent.auth` (`gateway` or `project-key`) is set through the same operation. The audit log records `set` or `removed`, never the value. The CLI accepts the key only through `--input @file.json` or `--input @-` (stdin); a flag such as `--anthropic-api-key` is refused.
- `runner.status` and `runner.overview` carry `agentAuth`: for each active (not archived) project whose roles use `claude-agent`, or that has a pending task whose `tools` override uses it, `{ projectId, roles, allowed, via: "gateway" | "project-key" | null, reason }`. A project on the gateway with no client key, or with no agent key, is `allowed: false` (unless it falls back to its project key). In the desktop app every entry is `allowed: false` with the unavailable reason, and the desktop app never asks the gateway.
- `tasks.inject` input `model`: optional, only with `mode: "now"` (otherwise 400 `model needs mode now`). It switches the model for the rest of the step. `claude-agent` interrupts the session and continues it in place; if the interrupt fails, boof kills the process and resumes the session. The other tools resume or rerun the step with the new model. A step takes at most 5 steers. `next-step` keeps its pipeline meaning for every tool.

Cost reported by `claude-agent` is an estimate. Usage whose model entry has `costBasis: "unknown"` is recorded with `known: false`. On a resumed session boof subtracts the earlier session's totals, and that usage is recorded with `known: false` too.

## Versioning

`/api/v1` is the stable surface. The old unversioned routes (`/api/projects/...`,
`/api/tasks...` for the default project) still work and answer with `Deprecation: true`,
`Sunset: Wed, 30 Jun 2027 00:00:00 GMT` and a `Link: <...>; rel="successor-version"` header.
They keep their old shapes (a task list is `{ "tasks": [...] }`, task bodies carry the log,
creates answer 200). Use `/api/v1` for new code.

## Errors

Every error is `{ "error": { "code", "message", "details"? } }` with the status below. Never zod
internals; validation errors list `details: [{ path, message }]`.

| Code                       | Status | Meaning                                                                                                  |
| -------------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `invalid_input`            | 400    | The input does not match the operation's schema, or an id is malformed.                                  |
| `invalid_plan`             | 400    | A plan or goal in the input is invalid (schema, dangling dependency, cycle).                             |
| `not_a_git_repo`           | 400    | The project directory is not a git work tree.                                                            |
| `nothing_to_import`        | 400    | The repository has no goal.boof.xml files to import.                                                     |
| `no_default_project`       | 404    | The unversioned task routes need settings.defaultProject, which is unset.                                |
| `unauthenticated`          | 401    | No credentials, or an invalid, expired or revoked API key.                                               |
| `forbidden_scope`          | 403    | The client lacks the scope the operation needs.                                                          |
| `forbidden_project`        | 403    | The client may not access this project.                                                                  |
| `forbidden_trust`          | 403    | The client has review trust: a human must approve this change.                                           |
| `project_root_not_allowed` | 403    | The directory is outside security.allowedProjectRoots.                                                   |
| `origin_not_allowed`       | 403    | The Origin header names a site that is not this server (a cross-site browser request).                   |
| `not_found`                | 404    | The task, command, client or webhook does not exist.                                                     |
| `project_not_found`        | 404    | The project does not exist.                                                                              |
| `branch_not_found`         | 404    | The task branch boof-runner/<id> does not exist (never ran in a worktree, or deleted by onDone=delete).  |
| `epic_not_found`           | 404    | The epic does not exist in this project.                                                                 |
| `parent_not_found`         | 404    | The parent task does not exist in this project.                                                          |
| `plan_not_found`           | 404    | The plan does not exist.                                                                                 |
| `goal_not_found`           | 404    | The goal does not exist in the plan.                                                                     |
| `conflict`                 | 409    | The change conflicts with the current state.                                                             |
| `invalid_transition`       | 409    | The task status transition is not allowed.                                                               |
| `invalid_hierarchy`        | 409    | The move or create breaks the hierarchy rules (one level of subtasks; a subtask has no epic of its own). |
| `has_children`             | 409    | The task has subtasks; pass detach to make them top-level tasks.                                         |
| `has_tasks`                | 409    | The epic has tasks; pass detach to clear their epic, or archive the epic instead.                        |
| `plan_version_conflict`    | 409    | The plan changed since the version in If-Match / expectedVersion.                                        |
| `settings_modified`        | 409    | The settings changed since the ETag in If-Match.                                                         |
| `task_modified`            | 409    | The task changed since the ETag in If-Match.                                                             |
| `plan_exists`              | 409    | A plan with this id already exists.                                                                      |
| `plan_not_active`          | 409    | The plan is not active; activate it before syncing.                                                      |
| `goal_has_dependents`      | 409    | Other goals depend on this one; pass cascade to remove them too.                                         |
| `project_exists`           | 409    | A project for this directory already exists.                                                             |
| `project_busy`             | 409    | A task of the project is running, or another project is being created right now; retry shortly.          |
| `directory_not_empty`      | 409    | The directory exists and is not empty; send path.confirm: true to initialise it anyway.                  |
| `idempotency_conflict`     | 409    | The Idempotency-Key was already used with a different request.                                           |
| `host_not_allowed`         | 421    | The Host header is not a loopback name or an allowed host.                                               |
| `payload_too_large`        | 413    | The request body exceeds the size limit.                                                                 |
| `unsupported_media_type`   | 415    | A JSON operation needs Content-Type: application/json.                                                   |
| `concierge_unavailable`    | 409    | The assistant cannot run here; the message says why.                                                     |
| `concierge_busy`           | 409    | A message to the assistant is still being answered.                                                      |
| `concierge_limit`          | 409    | The conversation reached its cost limit; start a new one.                                                |
| `budget_exceeded`          | 409    | A daily budget that covers the assistant is used up.                                                     |
| `change_not_found`         | 404    | The pending change does not exist, belongs to another caller, or is no longer pending.                   |
| `change_stale`             | 409    | The target changed since the assistant proposed this change.                                             |
| `change_expired`           | 409    | The pending change expired (15 minutes).                                                                 |
| `rate_limited`             | 429    | Too many requests; retry after the Retry-After header.                                                   |
| `internal`                 | 500    | Unexpected server error; details are in the server log.                                                  |

## Concurrency (ETag / If-Match)

- **Plans** carry an integer `version`. Every plan response has `ETag: "<version>"`. Send
  `If-Match: "<version>"` (or `expectedVersion` in the body) on a write; a stale version is
  `409 plan_version_conflict` with `details.currentVersion` and `details.expectedVersion`.
  Without either, the change applies to the latest version.
- **Tasks**: `GET` answers a weak `ETag: W/"<updated>"`. `PUT /projects/{p}/tasks/{id}` with
  `If-Match: W/"<updated>"` (or `expectedUpdated` in the body) is `409 task_modified` when the
  task changed since. The check and the write happen under the task's lock: of two writes carrying
  the same ETag exactly one succeeds.
- **Settings**: `GET /settings` and `PUT /settings` answer a weak `ETag: W/"<hash>"` of the settings
  a client can read (the webhook list is not part of it). `PUT /settings` with `If-Match` (or
  `expectedUpdated` in the body) is `409 settings_modified` when the settings changed since, and
  writes nothing. The check and the write happen under the settings lock. Without `If-Match` (or
  with `*`) the write is unconditional, as before.

## Idempotency

`projects.create`, `plans.create` and `tasks.create` accept `Idempotency-Key: <1-255 printable
characters>`. The first successful response is stored for 24 hours under
`<data>/idempotency/` (keyed by client, operation and key) and replayed with
`Idempotency-Replayed: true`. The same key with different input is `409 idempotency_conflict`.
Two requests in flight with the same key run once: the second waits for the first and replays its
response. A key that another server process is still processing answers `409 conflict`; retry
after a moment. An operation under one key should finish well within 60 seconds: after that a
marker counts as left by a crash. Two processes recovering the same stale marker at the same
instant can both run the operation (a crash-recovery limit).
Failed requests are not stored, so a corrected retry works. Expired records are pruned when the
server starts.

## Pagination and large fields

- `GET /projects/{p}/tasks?status=&plan=&label=&limit=&cursor=` returns
  `{ "items": [...], "nextCursor": "..." | null }`, newest update first; `limit` defaults to 100,
  max 500. Pass `nextCursor` as `cursor` for the next page. Other lists are small and not paged.
- Task responses leave out `body.log` (can be megabytes). `GET /projects/{p}/tasks/{id}?include=log`
  adds it; `GET .../tasks/{id}/live-log` streams the current log of a running task; `?tail=N` returns only the last N lines (JSON and `format=text`; also the `tail` argument of `boof_get_task_log`).

## Events

Every status change and plan write appends a line to `<project>/events.jsonl` (runner toggles go
to `<data>/events.jsonl`); files rotate monthly. Event types:

| Type                     | Fields (besides `ts`, `type`)                                                          |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `task.created`           | `project`, `task`, `status`, `by`                                                      |
| `task.status`            | `project`, `task`, `from`, `to`, `by`                                                  |
| `task.questions`         | `project`, `task`, `count`, `by`                                                       |
| `plan.updated`           | `project`, `plan`, `version`, `by`                                                     |
| `plan.synced`            | `project`, `plan`, `created`, `updated`, `by`                                          |
| `task.moved`             | `project`, `task`, `from`, `to` (each `{ epicId, parentId }`, `null` when unset), `by` |
| `epic.updated`           | `project`, `epic`, `change` (`created`, `updated`, `deleted`), `by`                    |
| `runner.enabled`         | `value`, `by`                                                                          |
| `runner.budget_exceeded` | `scope`, `date`, `spentUsd`, `limitUsd`, `project?`, `by`                              |
| `runner.pool_exhausted`  | `status`, `reason`, `nextAvailableAt`, `by`                                            |

`by` is the principal id or `runner`.

### Server-Sent Events

`GET /api/v1/events?project=<id>&since=<cursor>` (scope `tasks:read`; only projects the client may
read). Each event arrives as `event: <type>`, `id: <cursor>`, `data: <event json>`.

- No `since`: only new events. `since=start`: replay everything. `since=<cursor>` or the
  `Last-Event-ID` header (browsers and SSE libraries send it on reconnect): replay what follows
  that event, then stay live. Cursors are opaque; an unknown one is `400`.
- `event: ready` opens the stream, `event: changed` (no id, never replayed) hints that files of a
  project changed without a typed event (the UI uses it for a running task's log).
- `event: unauthorized` (data `{ message }`) ends the stream when the key was revoked, expired or
  lost `tasks:read` meanwhile, or when `auth.mode` changed. The check runs at every tick (each
  change and a 2 s poll), so a revocation stops a stream within a few seconds: within the 2 s poll for a key
  revoked in the server process, up to about 7 s (5 s client cache plus the 2 s poll) when
  `boof-runner auth revoke` runs in another process. Get a new key and reconnect. At most 16 open
  streams per principal; the 17th answers `429 rate_limited` with `Retry-After: 5`.

```bash
curl -N -H "Authorization: Bearer $BOOF" "http://127.0.0.1:4319/api/v1/events?since=start"
```

### Webhooks

Admin only (`admin` scope). Webhooks live in `settings.webhooks`; their signing secrets live in
`<data>/webhooks/secrets.json` (mode 0600 on POSIX filesystems, never in `settings.json`; an older data root is migrated
at start; an older boof-runner cannot load a `settings.json` whose webhooks lost their inline secret, so to downgrade restore the secrets into `settings.json` or delete the webhooks first). They are managed through
`POST/GET /webhooks`, `PUT /webhooks/{id}` (enable, disable or edit `url`, `events` and `projects`; the secret and the creator never change and the secret is never returned; disabling skips the events that happen meanwhile and drops queued retries, so enabling starts fresh, and a change of URL, events or projects drops queued retries that no longer fit; a webhook made by a project-restricted client cannot be widened beyond that client's projects, and the list gives `notDelivering` when the creator is revoked, expired or out of reach; MCP: `boof_update_webhook`) and `DELETE /webhooks/{id}`, and are **delivered by the server process only**
(`boof-runner` serve / the desktop app), not by headless `run`/`scan`.

```bash
curl -X POST http://127.0.0.1:4319/api/v1/webhooks -H "Authorization: Bearer $BOOF" \
  -H 'content-type: application/json' \
  -d '{"url":"https://harness.example/hooks/boof","events":["task.*","plan.*"],"projects":["shop"]}'
# => { "webhook": { "id": "wh-1a2b3c4d", ... }, "secret": "whsec_..." }   (the secret is shown once)
```

- `events`: types or `prefix.*` patterns (default `*`); `projects`: `"*"` or a list. Events
  without a project (`runner.enabled`, and `runner.budget_exceeded` for `global` and `tool:` scopes) reach webhooks with `projects: "*"` only.
- The URL must be http or https and must not point at the boof server itself, nor at a loopback, link-local, private (RFC 1918, ULA), carrier-grade NAT, multicast or reserved address, by literal or by name: the host is resolved when the webhook is created and again before every delivery; a delivery whose name resolves inside is a failed attempt (`blocked: …`), retried on the schedule and never sent. Redirects are not followed. The delivery connects to the addresses the check approved and does not resolve the name again (the URL's host stays the `Host` header and the TLS server name), so a TTL-0 DNS rebind between the check and the connection cannot redirect it; a host listed in `security.allowedPrivateWebhookHosts` is resolved normally. Webhooks created before this check that point at loopback or private addresses start failing with `blocked:` after an upgrade until their host is added to `security.allowedPrivateWebhookHosts`; Tailscale addresses (100.64.0.0/10) are a common example. To reach an endpoint on a private network on purpose, list its hostname or IP literal in `security.allowedPrivateWebhookHosts` (`"*"` turns the check off).
- A delivery is `POST <url>` with body `{ "id": "<delivery id>", "ts", "type", ...event }` and
  headers `X-Boof-Event`, `X-Boof-Delivery` (a uuid-shaped id that is the same for every delivery of one event to one webhook: retries, and the copy sent again after a server crash or a handover between servers. Use it as the idempotency key and drop an id you have handled) and
  `X-Boof-Signature: sha256=<hex>`, the HMAC-SHA256 of the raw body with the secret. Verify it
  before trusting the body:

  ```js
  const sig = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(req.headers["x-boof-signature"]));
  ```

- Any 2xx is success; redirects count as failure. Retries after 5 s, 30 s, 2 min, 10 min and
  1 h, then the delivery moves to `<data>/webhooks/dead/<delivery id>.json`. Progress per webhook
  (cursor and pending retries) is in `<data>/webhooks/state.json`, so a restart resumes. A new
  webhook only receives events from its creation on.

## Reviewing a task's changes

`GET /api/v1/projects/{projectId}/tasks/{taskId}/diff` (scope `tasks:read`, MCP `boof_get_task_diff`)
compares the task branch `boof-runner/<id>` with its base (the recorded `baseSha`, else the
merge-base with `baseRef` or `HEAD`). It only reads the repository.

- Query: `path` (one repo-relative file; no `..`, not absolute; returns just that patch), `context`
  (lines of context, default 3) and `maxBytes` (default 400000).
- Result: `base` and `head` (`{ref, sha}`), `files` (`path`, `oldPath`, `status` of `added`,
  `modified`, `deleted`, `renamed` or `binary`, `additions`, `deletions`), `stats`, `commits`
  (`sha`, `subject`, `author`, `date`), `patch` (unified diff), `truncated`, and `leftovers`
  (`{ref, sha}` of the `--leftovers` branch) when it exists.
- A diff over `maxBytes` returns the file list with `truncated: true` and no `patch`; fetch the
  files one at a time with `path`.
- A task whose worktree is still on disk (running, failed or stopped) adds its uncommitted and
  untracked changes and sets `includesUncommitted: true`.
- `404 branch_not_found` when the branch does not exist, for example after `onDone: delete`.

```bash
curl -s -H "Authorization: Bearer $BOOF" \
  "http://127.0.0.1:4319/api/v1/projects/shop/tasks/add-login/diff?path=src/auth.ts"
```

## The harness flow with curl

```bash
B=http://127.0.0.1:4319/api/v1
H=(-H "Authorization: Bearer $BOOF" -H 'content-type: application/json')

# 1. Register the repository (needs an allowed root for API clients)
curl -s "${H[@]}" -X POST $B/projects -H 'Idempotency-Key: shop-1' \
  -d '{"workingDirectory":"/home/me/repos/shop","id":"shop"}'

# 2. Submit a plan with dependent goals (status active so it can be synced)
curl -s "${H[@]}" -X POST $B/projects/shop/plans -d '{
  "id":"q4","title":"Q4","status":"active","autoSync":true,
  "goals":[
    {"id":"auth","title":"Auth","spec":{"goal":"Add login","stack":"TypeScript",
      "rules":{"do":["Write a failing test first."]},
      "tests":{"strategy":"TDD","technology":"vitest","run":"npm test"}}},
    {"id":"profile","title":"Profile","dependsOn":["auth"],"spec":{"goal":"Profile page","stack":"TypeScript",
      "rules":{"do":["Write a failing test first."]},
      "tests":{"strategy":"TDD","technology":"vitest","run":"npm test"}}}
  ]}' -i | head -n 12                                   # note the ETag: "1"

# 3. Sync: one task per unblocked goal
curl -s "${H[@]}" -X POST $B/projects/shop/plans/q4/sync

# 4. Follow progress and read reports
curl -N "${H[@]}" "$B/events?project=shop"            # SSE
curl -s "${H[@]}" "$B/projects/shop/tasks?status=done"
curl -s "${H[@]}" "$B/projects/shop/tasks/<task-id>?include=log"

# 5. Requirements change: update a goal conditionally, then re-sync
curl -s "${H[@]}" -X PUT $B/projects/shop/plans/q4/goals/auth -H 'If-Match: "1"' -d '{
  "title":"Auth","spec":{"goal":"Add login with audit logging","stack":"TypeScript",
  "rules":{"do":["Write a failing test first."]},
  "tests":{"strategy":"TDD","technology":"vitest","run":"npm test"}}}'
curl -s "${H[@]}" -X POST $B/projects/shop/plans/q4/sync   # rewrites pending prompts, injects
                                                           # notes, follow-up tasks for done goals

# 6. Answer questions a task parked in `action`
curl -s "${H[@]}" "$B/actions"
curl -s "${H[@]}" -X POST $B/projects/shop/tasks/<task-id>/answers -d '{"answers":"Use OAuth."}'
```

## MCP

The same operations are served over the Model Context Protocol: `boof-runner mcp` (stdio, for a
local agent host) and `POST /mcp` on the HTTP server (Streamable HTTP, for remote harnesses).
Each tool calls the same operation as its REST route, so scopes, project restrictions, trust
rules, input validation and error codes are identical, and every call is audited.

- **Auth.** HTTP: `Authorization: Bearer boof_...` (or no header from a loopback peer under
  `local-trust`; that caller is not the UI's administrator but the review-trust `local-mcp` principal, with its own rate-limit bucket and audit name, no administration tools, and `403` while `clients.json` holds a stored client of that reserved id), after the Host guard, an `Origin` check (absent, or an allowed host, and no
  `Sec-Fetch-Site: cross-site`; else `403 origin_not_allowed`), the body limit and the rate limit. stdio: `--client <id>` (no key
  needed), or the local principal under `local-trust`; with `auth.mode = "required"` and no
  `--client` the command refuses to start.
- **Stateless.** One request, one answer (`application/json`). No sessions, so GET and DELETE on
  `/mcp` answer `405` and there are no server-initiated notifications. Use `boof_wait_task`
  (long poll, at most 60 s) or the SSE stream and webhooks above to follow progress. A wait ends as soon as the caller goes away: an HTTP disconnect, or an MCP `notifications/cancelled`. The server advertises `listChanged: false` for tools, resources and prompts.
- **Results.** Success: `content[0]` is a one-line summary, `content[1]` the JSON result,
  `structuredContent` the result. Failure: `isError: true` and text `<code>: <message> <details>`
  with the codes of the Errors section (`plan_version_conflict`, `forbidden_scope`, ...).
- **Switch.** `settings.mcp.enabled` (default `true`); `false` makes `/mcp` answer 404 and
  `boof-runner mcp` refuse to start.
- **Audit.** `action` is `mcp:<tool>` for a tool call and `mcp:<method>` otherwise.
- `boof-runner mcp --project <id>` fills in `projectId` for every project-scoped tool, removes
  it from the tool schemas and hides `boof_create_project`, other projects and the API-client and
  webhook tools (a server pinned to one project is a project tool).
- `tools/list` shows only the tools the caller's scopes allow, and a call outside them answers
  `forbidden_scope`.
- **Administration tools.** Every operation is a tool except attachment upload and download (REST
  only), including API clients, webhooks, settings, command templates and project deletion. Keys
  and signing secrets appear once, in the result (never in the summary line). Over stdio,
  `boof-runner mcp` without `--client` acts as the reserved review-trust principal `local-mcp`
  (every scope except `admin`, `auth:admin` and `settings:write`; not stored in `clients.json`), so
  everything a review-trust client may not do is refused: tasks and plans it creates are drafts a
  human approves, it cannot queue, retry, answer, activate a plan or switch the runner, it changes
  only its own work and only the name, labels and paused state of a project, and it creates no
  project. With `--admin` it is the local administrator and lists the administration tools too;
  with `--client <id>` that client's scopes decide and `--admin` is refused. All keyless hosts share this one `local-mcp` identity; a client of that id left over from before
  the id was reserved makes the keyless server refuse to start (and `serve` warns). It is a boundary
  for MCP-only hosts only: a host whose model also has a shell can approve its own drafts through the
  CLI or `curl` to the loopback API (goal `agent-containment`). Give agent hosts
  `--client` with a narrow client. `projects.archive`, `unarchive` and `delete` (purge) are
  refused to review-trust keys over REST and MCP alike. `POST /mcp` refuses JSON-RPC batches.

Tools (the names are stable). Plan tools take `expectedVersion`, task updates `expectedUpdated`
(the ETag/If-Match values of the REST API). The table lists the tools of the common flow; the
full set is every operation of the OpenAPI document (its `x-mcp-tool` key names the tool).

| Tool                   | Scope                                | Kind        | Does                                     |
| ---------------------- | ------------------------------------ | ----------- | ---------------------------------------- |
| `boof_whoami`          | none (any authenticated client)      | read-only   | Who am I and server facts                |
| `boof_list_projects`   | `projects:read`                      | read-only   | List projects                            |
| `boof_create_project`  | `projects:write`                     | write       | Create a project                         |
| `boof_get_project`     | `projects:read`                      | read-only   | Get a project                            |
| `boof_update_project`  | `projects:write`                     | idempotent  | Update a project                         |
| `boof_list_plans`      | `plans:read`                         | read-only   | List plans                               |
| `boof_create_plan`     | `plans:write`                        | write       | Create a plan                            |
| `boof_get_plan`        | `plans:read`                         | read-only   | Get a plan                               |
| `boof_update_plan`     | `plans:write`                        | idempotent  | Update a plan                            |
| `boof_replace_goals`   | `plans:write`                        | idempotent  | Replace all goals of a plan              |
| `boof_upsert_goal`     | `plans:write`                        | idempotent  | Add or change a goal                     |
| `boof_remove_goal`     | `plans:write`                        | destructive | Remove a goal                            |
| `boof_reorder_goals`   | `plans:write`                        | idempotent  | Reorder goals                            |
| `boof_set_goal_status` | `plans:write`                        | idempotent  | Set a goal's status                      |
| `boof_import_plan`     | `plans:write`                        | write       | Import plan files from the repository    |
| `boof_export_plan`     | `plans:read`                         | read-only   | Export a plan as boof-planner files      |
| `boof_sync_plan`       | `plans:write`                        | write       | Sync a plan to tasks                     |
| `boof_list_tasks`      | `tasks:read`                         | read-only   | List tasks                               |
| `boof_get_task`        | `tasks:read`                         | read-only   | Get a task                               |
| `boof_get_task_diff`   | `tasks:read`                         | read-only   | Get what a task changed                  |
| `boof_create_task`     | `tasks:write`                        | write       | Create a task                            |
| `boof_update_task`     | `tasks:write`                        | idempotent  | Update a task                            |
| `boof_move_task`       | `tasks:write`                        | idempotent  | Move a task to an epic or under a parent |
| `boof_queue_task`      | `tasks:write`                        | idempotent  | Queue a task                             |
| `boof_retry_task`      | `tasks:write`                        | write       | Retry a task                             |
| `boof_archive_task`    | `tasks:write`                        | idempotent  | Archive a task                           |
| `boof_answer_task`     | `tasks:write`                        | write       | Answer a task's questions                |
| `boof_stop_task`       | `tasks:control`                      | destructive | Stop a running task                      |
| `boof_inject_prompt`   | `tasks:control`                      | write       | Inject a prompt (next-step or now)       |
| `boof_get_task_log`    | `tasks:read`                         | read-only   | Read a task's live log (optional `tail`) |
| `boof_wait_task`       | `tasks:read`                         | read-only   | Wait for a task status change            |
| `boof_list_epics`      | `tasks:read`                         | read-only   | List a project's epics                   |
| `boof_get_epic`        | `tasks:read`                         | read-only   | Get an epic                              |
| `boof_create_epic`     | `tasks:write`                        | write       | Create an epic                           |
| `boof_update_epic`     | `tasks:write`                        | idempotent  | Update an epic                           |
| `boof_runner_status`   | `settings:read`                      | read-only   | Runner and queue status                  |
| `boof_set_runner`      | `runner:control` or `settings:write` | idempotent  | Start or pause the runner                |
| `boof_list_actions`    | `tasks:read`                         | read-only   | List tasks needing an answer             |

Resources (read-only, same scopes as the matching tools): `resources/list` leaves out what the client's scopes or project restriction do not allow instead of failing; listing project, task and plan resources needs `projects:read` plus the resource's read scope (the static `boof://projects` entry is always listed); a read without the scope is an error.

| URI                                                 | MIME               | Content                              |
| --------------------------------------------------- | ------------------ | ------------------------------------ |
| `boof://projects`                                   | `application/json` | project list                         |
| `boof://projects/{pid}`                             | `application/json` | one project                          |
| `boof://projects/{pid}/plans/{planId}`              | `application/json` | plan with goals                      |
| `boof://projects/{pid}/plans/{planId}/xml`          | `text/plain`       | exported `plan.boof.xml`             |
| `boof://projects/{pid}/plans/{planId}/xml/{goalId}` | `text/plain`       | exported `goal.boof.xml` of one goal |
| `boof://projects/{pid}/tasks/{taskId}`              | `application/json` | task without its log                 |
| `boof://projects/{pid}/tasks/{taskId}/log`          | `text/plain`       | live or stored log                   |

Prompts: `boof_plan_project` (goal and repository summary to a plan ready for
`boof_create_plan`) and `boof_review_plan` (critique a plan's dependency graph and tests).

```bash
curl -s http://127.0.0.1:4319/mcp \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"boof_list_projects","arguments":{}}}'
```

## Console assistant (concierge)

Free text in the bottom console that is not a command goes to the concierge, one project at a
time (the project being viewed). It does not answer across projects, and it does not propose
project descriptions. The same five operations are REST and CLI. They are not MCP tools.

| Operation           | Method and path                                                   | CLI                             |
| ------------------- | ----------------------------------------------------------------- | ------------------------------- |
| `concierge.status`  | `GET /projects/{projectId}/concierge`                             | `boof-runner concierge status`  |
| `concierge.ask`     | `POST /projects/{projectId}/concierge/messages`                   | `boof-runner concierge ask`     |
| `concierge.apply`   | `POST /projects/{projectId}/concierge/changes/{changeId}/apply`   | `boof-runner concierge apply`   |
| `concierge.discard` | `POST /projects/{projectId}/concierge/changes/{changeId}/discard` | `boof-runner concierge discard` |
| `concierge.reset`   | `POST /projects/{projectId}/concierge/reset`                      | `boof-runner concierge reset`   |

Each needs `tasks:read` and is project-scoped. `ask` takes `{ text }` (1–4000 characters after
trim), and optionally `context` (`screen`, and `taskId`, `planId`, `goalId`) and `conversationId`.
The audit line stores a fingerprint of the text, not the text. `apply` returns `{ change, result }`
and runs the stored operation **as the caller** (the caller's scopes, trust and projects), after
the stale-guard check. A second apply, another caller, or a change that is no longer pending is
`404 change_not_found`. A changed target is `409 change_stale`. `discard` runs nothing.

`POST /api/v1/projects/{projectId}/concierge/messages/stream` (and the unversioned path, because
the other SSE routes have one) takes the same body, the same scope and `authorizeProject`. It
answers `text/event-stream` with `X-Accel-Buffering: no`. Events, in the order the turn produces
them: `conversation`, `text`, `tool` (`start` / `end`), `change`, `pending`, `done`, `error`.
Validation and refusals that happen before a model call answer as normal JSON, with the same
codes, before the stream opens.

**Principal.** Each request builds an in-memory principal `concierge-<userId>` (`trust: "review"`,
`alwaysReview`). Its scopes are {`projects:read`, `plans:read`, `plans:write`, `tasks:read`,
`tasks:write`} ∩ the user's scopes. Its projects are {the pinned project} ∩ the user's projects.
It never holds `admin`, `auth:admin`, `settings:*`, `runner:control`, `tasks:control` or
`projects:write`. No key is stored. New client ids that would start with `concierge-` are issued
as `client-concierge…` instead. A leftover `concierge-*` row in `auth/clients.json` still appears
in the client list, but `get`, revoke and rotate return 404 for that id and the key cannot
authenticate. The assistant then answers `409 concierge_unavailable` and names the file: remove
the entry from `auth/clients.json`.

**Tools** the concierge may call, on the pinned project only. Reads run. Writes run only where
review trust already allows them (its own drafts). A `confirm` tool, or a `write` that boof
refuses with `forbidden_trust`, does not run: the server stores a pending change (validated
input, a preview computed from the store, a stale-guard) and tells the model it is waiting.
The user sees the title and details. A change the operation will refuse is marked `blocked`
with the reason and the dialog offers no Confirm, only Discard and Close.

| Mode      | Operations                                                                                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`    | `projects.get`, `plans.list`, `plans.get`, `tasks.list`, `tasks.get`, `tasks.liveLog`, `epics.list`, `epics.get`, `usage.budget`, `commands.list`                             |
| `write`   | `tasks.create`, `tasks.update`, `tasks.move`, `epics.create`, `epics.update`, `plans.create`, `plans.update`, `plans.upsertGoal`, `plans.reorderGoals`, `plans.setGoalStatus` |
| `confirm` | `tasks.delete`, `tasks.archive`, `tasks.queue`, `epics.delete`, `plans.removeGoal`, `plans.replaceGoals`                                                                      |

Not offered: `tasks.diff`, `plans.import`, the `*.wait` polls, `tasks.stop`, `tasks.inject`,
`tasks.answers`, `tasks.retry`, `tasks.skip`, `plans.sync`, project writes, settings, accounts,
the runner, auth, webhooks, command writes and attachments. One message stores at most 5 pending
changes; a conversation holds at most 20. A pending change stays appliable for 15 minutes
(`change_expired` after that). `concierge.reset` (the console's `/new`) ends the live
conversation and leaves pending changes appliable until they expire or are discarded.

**Caps** come from `settings.concierge`, which is file-only: it is not in `PUT /settings`. An
invalid block fails settings load. `"enabled": false` is how you turn the assistant off
(`The assistant is turned off (settings.concierge.enabled is false).`). Bounds and defaults:

| Key                  | Default   | Allowed                     |
| -------------------- | --------- | --------------------------- |
| `enabled`            | `true`    | boolean                     |
| `model`              | `default` | 1–100 of `A-Za-z0-9._:[]/-` |
| `perMessageUsd`      | `0.25`    | `> 0` and `≤ 50`            |
| `perConversationUsd` | `2`       | `> 0` and `≤ 500`           |
| `messagesPerMinute`  | `6`       | integer 1–60, per user      |
| `maxTurns`           | `8`       | integer 1–20                |
| `timeoutMs`          | `120000`  | integer 10 000–600 000      |
| `idleMinutes`        | `30`      | integer 5–240               |

One message is in flight per (user, project) (`409 concierge_busy`). A message counts toward
`messagesPerMinute` once availability has passed, including when a later check refuses it
(`concierge_busy`, `budget_exceeded`, `concierge_limit`, an unknown conversation). Turned off,
not wired, a reserved-id collision and an unavailable model do not count. The CLI builds a new
service per invocation, so the per-minute window and the busy flag start empty each time; the
daily budgets and the conversation cost cap are on disk and still apply. Spend is `tool:concierge`
(`tool:concierge` and `project:<id>/tool:concierge`). A spent day scope is `409 budget_exceeded`
before any model call. The conversation cap is `409 concierge_limit`.

**No MCP tools.** `mcp.expose` is false because an MCP host is itself a model: driving the
assistant would spend budget model-to-model and could confirm its own proposals. The operations
the concierge uses are already MCP tools.

## Operations

The full list, inputs and outputs are in the OpenAPI document. Areas: `projects.*`, `plans.*`
(goals, import/export, sync), `tasks.*` (queue, answers, stop, inject, attachments), `epics.*`,
`auth.whoami`, `actions.list`, `settings.*`, `runner.*`, `usage.global`, `usage.budget`, `commands.*`, `auth.clients.*`,
`webhooks.*`. Request bodies are strict: unknown keys are `400 invalid_input`. GET and DELETE
inputs come from the query string (`?purge=1`, `?cascade=true`); path placeholders are input
fields; everything else is the JSON body. Bodies are limited to 1 MB (attachments 25 MB).

`projects.create` takes `workingDirectory` (an existing work tree) or `path` (`{mode: "existing"|"new", directory}`
or `{mode: "auto"}`) plus `brief` (required for `new` and `auto`); see the OpenAPI document for the shapes.

`tasks.create` takes an optional `epicId` or `parentId` (not both: a subtask takes its parent's epic;
one level of subtasks only). `tasks.list` filters by `epic` and `parent` (the value `none` is reserved:
no epic, or top-level; an epic filter also matches subtasks through their parent) and takes
`order=priority` for scheduler order, with its own cursor (a cursor from the other order is
`400`). Tasks show derived fields: the effective `epicId`, `subtasks: {total, done}` and the flags
`parentMissing` / `epicMissing` for a hand-edited dangling reference. These appear on `tasks.list`,
`tasks.get` and `tasks.create` (and `tasks.move` and `tasks.queue`), not on the other task operations.

`tasks.move` (`POST /projects/{id}/tasks/{taskId}/move`) sets a task's `epicId` or `parentId` (not both,
`null` clears); setting a parent clears the task's own epic, and a review-trust client may move only
tasks it created. `tasks.delete` refuses a task with subtasks (`409 has_children`) unless `?detach=true`:
the subtasks become top-level tasks in the parent's epic, and the result lists them in `detached`
(review-trust clients may not detach). Queuing a parent whose subtasks are not all done succeeds with
the warning `subtasks_open` (header `Boof-Warning`, next to `status_downgraded`); nothing waits for the
subtasks. Webhooks subscribed to `task.*` or `*` now also receive `task.moved`.

`epics.*` manage a project's epics (`list`, `get`, `create`, `update`, `delete`). `epics.update` is
`PUT` with a partial body (the contract has no `PATCH`) and takes `If-Match` with the epic's ETag
(`409 epic_modified` when stale). Every epic carries `progress: {total, done}` over its non-archived
top-level tasks. `epics.delete` refuses an epic that tasks name (`409 has_tasks`) unless `?detach=true`,
which clears their epic; archiving keeps the grouping. Review-trust clients may create epics and update only the
epics they created (`origin.client`; an epic without `origin` is a human's: `403 forbidden_trust`), and never delete one.
`If-Match` takes a single ETag (a list is `400`; weak and strong forms both match) and wins over a body
`expectedUpdated`. An empty `PUT` body changes nothing and keeps the ETag. Epics need the `tasks:read` / `tasks:write` scopes.

Goals in `plans.*` inputs take an optional `epicId` (omitted keeps the stored one, `null` clears it);
plan sync copies it onto the goal's task.

No `GET` changes state or runs anything: `GET /health` and `GET /models` (and `GET /models/details`) answer
from the last probe of this server process, and `POST /health/check` (needs `settings:write`: it sends each tool a short, paid prompt; concurrent calls share one check and one under a minute old is not repeated) and `POST /models/refresh` run the
tool probes and remember the results. (The audit log and a client's `lastUsedAt` are bookkeeping, not
state a `GET` changes. Reading settings does not create `settings.json` when it is missing: startup does.) `get-no-side-effects.test.ts` calls every `GET` and checks the data root. A task diff runs git with `--no-optional-locks`, so it never takes `index.lock` in a worktree an agent is committing in.

### Editing the contract

Operations are defined once with `defineOp()` in `packages/heart-server/src/api/ops/`. After a change run
`UPDATE_OPENAPI=1 npx vitest run packages/heart-server/src/api/openapi.test.ts` to rewrite the committed OpenAPI snapshot; the
test fails otherwise, so the diff of `openapi.json` shows up in review.
