# boof-runner REST API (v1)

The API is generated from one operations registry (`packages/api`), so REST and the MCP tools
(see "MCP" below) stay identical. The machine-readable contract is the OpenAPI 3.1 document at
`GET /api/v1/openapi.json` (a sorted copy is committed as `packages/api/openapi/openapi.json`).
Generate a client from it, or use the examples below.

**Using an AI agent?** Point it at `<boof-host>/harness.txt` (public, no key; also `/harness.md` and `/llms.txt`), or `https://nodets.com/boof/harness.txt`. That guide, [harness.md](harness.md), holds a complete generated reference of every operation below.

Base URL: `http://127.0.0.1:4319/api/v1` (default bind). Every operation has an id
(`projects.create`), a scope, JSON input and JSON output.

## Authentication and scopes

- Loopback peers are trusted as the local user when `security.auth.mode` is `local-trust` (the
  default). Anything else needs `Authorization: Bearer boof_...`.
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
- A client may be restricted to some projects. Touching another project is
  `403 forbidden_project`; project lists are filtered.
- **Trust.** A client with `trust: review` (the default for new clients) creates `draft` tasks
  and plans, cannot queue tasks or activate plans, and a human approves in the UI. A `trusted`
  client may queue directly.
- Registering a project as an API client needs the directory to be inside
  `security.allowedProjectRoots` (settings.json).
- `GET /api/v1/openapi.json` needs any valid principal.
- `GET /api/v1/whoami` (MCP `boof_whoami`) needs no scope: it returns `{ principal: { kind, id, name, trust, scopes[], projects }, server: { version, authMode, mcpEnabled } }`. Call it first to learn what a key may do.

## Versioning

`/api/v1` is the stable surface. The old unversioned routes (`/api/projects/...`,
`/api/tasks...` for the default project) still work and answer with `Deprecation: true`,
`Sunset: Wed, 30 Jun 2027 00:00:00 GMT` and a `Link: <...>; rel="successor-version"` header.
They keep their old shapes (a task list is `{ "tasks": [...] }`, task bodies carry the log,
creates answer 200). Use `/api/v1` for new code.

## Errors

Every error is `{ "error": { "code", "message", "details"? } }` with the status below. Never zod
internals; validation errors list `details: [{ path, message }]`.

| Code                       | Status | Meaning                                                                                                 |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| `invalid_input`            | 400    | The input does not match the operation's schema, or an id is malformed.                                 |
| `invalid_plan`             | 400    | A plan or goal in the input is invalid (schema, dangling dependency, cycle).                            |
| `not_a_git_repo`           | 400    | The project directory is not a git work tree.                                                           |
| `nothing_to_import`        | 400    | The repository has no goal.boof.xml files to import.                                                    |
| `no_default_project`       | 404    | The unversioned task routes need settings.defaultProject, which is unset.                               |
| `unauthenticated`          | 401    | No credentials, or an invalid, expired or revoked API key.                                              |
| `forbidden_scope`          | 403    | The client lacks the scope the operation needs.                                                         |
| `forbidden_project`        | 403    | The client may not access this project.                                                                 |
| `forbidden_trust`          | 403    | The client has review trust: a human must approve this change.                                          |
| `project_root_not_allowed` | 403    | The directory is outside security.allowedProjectRoots.                                                  |
| `not_found`                | 404    | The task, command, client or webhook does not exist.                                                    |
| `project_not_found`        | 404    | The project does not exist.                                                                             |
| `branch_not_found`         | 404    | The task branch boof-runner/<id> does not exist (never ran in a worktree, or deleted by onDone=delete). |
| `plan_not_found`           | 404    | The plan does not exist.                                                                                |
| `goal_not_found`           | 404    | The goal does not exist in the plan.                                                                    |
| `conflict`                 | 409    | The change conflicts with the current state.                                                            |
| `invalid_transition`       | 409    | The task status transition is not allowed.                                                              |
| `plan_version_conflict`    | 409    | The plan changed since the version in If-Match / expectedVersion.                                       |
| `task_modified`            | 409    | The task changed since the ETag in If-Match.                                                            |
| `plan_exists`              | 409    | A plan with this id already exists.                                                                     |
| `plan_not_active`          | 409    | The plan is not active; activate it before syncing.                                                     |
| `goal_has_dependents`      | 409    | Other goals depend on this one; pass cascade to remove them too.                                        |
| `project_exists`           | 409    | A project for this directory already exists.                                                            |
| `project_busy`             | 409    | A task of the project is running.                                                                       |
| `idempotency_conflict`     | 409    | The Idempotency-Key was already used with a different request.                                          |
| `host_not_allowed`         | 421    | The Host header is not a loopback name or an allowed host.                                              |
| `payload_too_large`        | 413    | The request body exceeds the size limit.                                                                |
| `rate_limited`             | 429    | Too many requests; retry after the Retry-After header.                                                  |
| `internal`                 | 500    | Unexpected server error; details are in the server log.                                                 |

## Concurrency (ETag / If-Match)

- **Plans** carry an integer `version`. Every plan response has `ETag: "<version>"`. Send
  `If-Match: "<version>"` (or `expectedVersion` in the body) on a write; a stale version is
  `409 plan_version_conflict` with `details.currentVersion` and `details.expectedVersion`.
  Without either, the change applies to the latest version.
- **Tasks**: `GET` answers a weak `ETag: W/"<updated>"`. `PUT /projects/{p}/tasks/{id}` with
  `If-Match: W/"<updated>"` (or `expectedUpdated` in the body) is `409 task_modified` when the
  task changed since.

## Idempotency

`projects.create`, `plans.create` and `tasks.create` accept `Idempotency-Key: <1-255 printable
characters>`. The first successful response is stored for 24 hours under
`<data>/idempotency/` (keyed by client, operation and key) and replayed with
`Idempotency-Replayed: true`. The same key with different input is `409 idempotency_conflict`.
Failed requests are not stored, so a corrected retry works. Expired records are pruned when the
server starts.

## Pagination and large fields

- `GET /projects/{p}/tasks?status=&plan=&label=&limit=&cursor=` returns
  `{ "items": [...], "nextCursor": "..." | null }`, newest update first; `limit` defaults to 100,
  max 500. Pass `nextCursor` as `cursor` for the next page. Other lists are small and not paged.
- Task responses leave out `body.log` (can be megabytes). `GET /projects/{p}/tasks/{id}?include=log`
  adds it; `GET .../tasks/{id}/live-log` streams the current log of a running task.

## Events

Every status change and plan write appends a line to `<project>/events.jsonl` (runner toggles go
to `<data>/events.jsonl`); files rotate monthly. Event types:

| Type                     | Fields (besides `ts`, `type`)                             |
| ------------------------ | --------------------------------------------------------- |
| `task.created`           | `project`, `task`, `status`, `by`                         |
| `task.status`            | `project`, `task`, `from`, `to`, `by`                     |
| `task.questions`         | `project`, `task`, `count`, `by`                          |
| `plan.updated`           | `project`, `plan`, `version`, `by`                        |
| `plan.synced`            | `project`, `plan`, `created`, `updated`, `by`             |
| `runner.enabled`         | `value`, `by`                                             |
| `runner.budget_exceeded` | `scope`, `date`, `spentUsd`, `limitUsd`, `project?`, `by` |

`by` is the principal id or `runner`.

### Server-Sent Events

`GET /api/v1/events?project=<id>&since=<cursor>` (scope `tasks:read`; only projects the client may
read). Each event arrives as `event: <type>`, `id: <cursor>`, `data: <event json>`.

- No `since`: only new events. `since=start`: replay everything. `since=<cursor>` or the
  `Last-Event-ID` header (browsers and SSE libraries send it on reconnect): replay what follows
  that event, then stay live. Cursors are opaque; an unknown one is `400`.
- `event: ready` opens the stream, `event: changed` (no id, never replayed) hints that files of a
  project changed without a typed event (the UI uses it for a running task's log).

```bash
curl -N -H "Authorization: Bearer $BOOF" "http://127.0.0.1:4319/api/v1/events?since=start"
```

### Webhooks

Admin only (`admin` scope). Webhooks live in `settings.webhooks`, are managed through
`POST/GET /webhooks` and `DELETE /webhooks/{id}`, and are **delivered by the server process only**
(`boof-runner` serve / the desktop app), not by headless `run`/`scan`.

```bash
curl -X POST http://127.0.0.1:4319/api/v1/webhooks -H "Authorization: Bearer $BOOF" \
  -H 'content-type: application/json' \
  -d '{"url":"https://harness.example/hooks/boof","events":["task.*","plan.*"],"projects":["shop"]}'
# => { "webhook": { "id": "wh-1a2b3c4d", ... }, "secret": "whsec_..." }   (the secret is shown once)
```

- `events`: types or `prefix.*` patterns (default `*`); `projects`: `"*"` or a list. Events
  without a project (`runner.enabled`, and `runner.budget_exceeded` for `global` and `tool:` scopes) reach webhooks with `projects: "*"` only.
- The URL must be http or https and must not point at the boof server itself.
- A delivery is `POST <url>` with body `{ "id": "<delivery id>", "ts", "type", ...event }` and
  headers `X-Boof-Event`, `X-Boof-Delivery` (uuid, same for retries) and
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
  `local-trust`), after the Host guard, an `Origin` check (absent, or an allowed host; else
  `403 origin_not_allowed`), the body limit and the rate limit. stdio: `--client <id>` (no key
  needed), or the local principal under `local-trust`; with `auth.mode = "required"` and no
  `--client` the command refuses to start.
- **Stateless.** One request, one answer (`application/json`). No sessions, so GET and DELETE on
  `/mcp` answer `405` and there are no server-initiated notifications. Use `boof_wait_task`
  (long poll, at most 60 s) or the SSE stream and webhooks above to follow progress.
- **Results.** Success: `content[0]` is a one-line summary, `content[1]` the JSON result,
  `structuredContent` the result. Failure: `isError: true` and text `<code>: <message> <details>`
  with the codes of the Errors section (`plan_version_conflict`, `forbidden_scope`, ...).
- **Switch.** `settings.mcp.enabled` (default `true`); `false` makes `/mcp` answer 404 and
  `boof-runner mcp` refuse to start.
- **Audit.** `action` is `mcp:<tool>` for a tool call and `mcp:<method>` otherwise.
- `boof-runner mcp --project <id>` fills in `projectId` for every project-scoped tool, removes
  it from the tool schemas and hides `boof_create_project` and other projects.
- `tools/list` shows only the tools the client's scopes allow.

Tools (the names are stable). Plan tools take `expectedVersion`, task updates `expectedUpdated`
(the ETag/If-Match values of the REST API). Attachments, settings writes, commands, clients
and webhooks are REST only; archive/pause/usage and similar low-value operations are REST only
to keep the tool list short.

| Tool                   | Scope                                | Kind        | Does                                  |
| ---------------------- | ------------------------------------ | ----------- | ------------------------------------- |
| `boof_whoami`          | none (any authenticated client)      | read-only   | Who am I and server facts             |
| `boof_list_projects`   | `projects:read`                      | read-only   | List projects                         |
| `boof_create_project`  | `projects:write`                     | write       | Create a project                      |
| `boof_get_project`     | `projects:read`                      | read-only   | Get a project                         |
| `boof_update_project`  | `projects:write`                     | idempotent  | Update a project                      |
| `boof_list_plans`      | `plans:read`                         | read-only   | List plans                            |
| `boof_create_plan`     | `plans:write`                        | write       | Create a plan                         |
| `boof_get_plan`        | `plans:read`                         | read-only   | Get a plan                            |
| `boof_update_plan`     | `plans:write`                        | idempotent  | Update a plan                         |
| `boof_replace_goals`   | `plans:write`                        | idempotent  | Replace all goals of a plan           |
| `boof_upsert_goal`     | `plans:write`                        | idempotent  | Add or change a goal                  |
| `boof_remove_goal`     | `plans:write`                        | destructive | Remove a goal                         |
| `boof_reorder_goals`   | `plans:write`                        | idempotent  | Reorder goals                         |
| `boof_set_goal_status` | `plans:write`                        | idempotent  | Set a goal's status                   |
| `boof_import_plan`     | `plans:write`                        | write       | Import plan files from the repository |
| `boof_export_plan`     | `plans:read`                         | read-only   | Export a plan as boof-planner files   |
| `boof_sync_plan`       | `plans:write`                        | write       | Sync a plan to tasks                  |
| `boof_list_tasks`      | `tasks:read`                         | read-only   | List tasks                            |
| `boof_get_task`        | `tasks:read`                         | read-only   | Get a task                            |
| `boof_get_task_diff`   | `tasks:read`                         | read-only   | Get what a task changed               |
| `boof_create_task`     | `tasks:write`                        | write       | Create a task                         |
| `boof_update_task`     | `tasks:write`                        | idempotent  | Update a task                         |
| `boof_queue_task`      | `tasks:write`                        | idempotent  | Queue a task                          |
| `boof_retry_task`      | `tasks:write`                        | write       | Retry a task                          |
| `boof_archive_task`    | `tasks:write`                        | idempotent  | Archive a task                        |
| `boof_answer_task`     | `tasks:write`                        | write       | Answer a task's questions             |
| `boof_stop_task`       | `tasks:control`                      | destructive | Stop a running task                   |
| `boof_inject_prompt`   | `tasks:control`                      | write       | Inject a prompt (next-step or now)    |
| `boof_get_task_log`    | `tasks:read`                         | read-only   | Read a task's live log                |
| `boof_wait_task`       | `tasks:read`                         | read-only   | Wait for a task status change         |
| `boof_runner_status`   | `settings:read`                      | read-only   | Runner and queue status               |
| `boof_set_runner`      | `runner:control` or `settings:write` | idempotent  | Start or pause the runner             |
| `boof_list_actions`    | `tasks:read`                         | read-only   | List tasks needing an answer          |

Resources (read-only, same scopes as the matching tools; the lists support browsing):

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

## Operations

The full list, inputs and outputs are in the OpenAPI document. Areas: `projects.*`, `plans.*`
(goals, import/export, sync), `tasks.*` (queue, answers, stop, inject, attachments),
`auth.whoami`, `actions.list`, `settings.*`, `runner.*`, `usage.global`, `usage.budget`, `commands.*`, `auth.clients.*`,
`webhooks.*`. Request bodies are strict: unknown keys are `400 invalid_input`. GET and DELETE
inputs come from the query string (`?purge=1`, `?cascade=true`); path placeholders are input
fields; everything else is the JSON body. Bodies are limited to 1 MB (attachments 25 MB).

### Editing the contract

Operations are defined once with `defineOp()` in `packages/api/src/ops/`. After a change run
`UPDATE_OPENAPI=1 npx vitest run packages/api` to rewrite the committed OpenAPI snapshot; the
test fails otherwise, so the diff of `openapi.json` shows up in review.
