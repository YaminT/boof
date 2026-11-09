# n8n external steps: design

Date: 2026-11-09
Status: design, approved by the owner on 2026-11-09 (answers below are final)
Implementation plan: `docs/superpowers/plans/2026-11-09-n8n-integration.md` (in the boof-ui checkout, git-ignored)

## Decision and scope

Decision D7 (owner, 2026-10-29): an n8n workflow can run as an optional step of boof's pipeline. Boof does not offer a "run one internal step" API. It calls an n8n webhook with the task context and waits for an authenticated, single-use callback that carries the result.

- The built-in pipeline stays the default. A project without `externalSteps` runs exactly today's steps and writes the same `steps[]` labels as before.
- n8n is optional and is never started, installed or supervised by boof.
- Containment layer 1 holds: there is no keyless loopback admin, and agents get no credential. The callback endpoint is a protocol endpoint for n8n, not an operation; it gives no admin rights.

In scope:

- `settings.n8n`: one n8n instance (`baseUrl` for the API, `webhookBaseUrl` for webhooks, `callbackBaseUrl` for the callback URL, `defaultTimeoutMs`, `checks`). The API key and the webhook secret live in `n8n/secrets.json` (0600).
- `project.externalSteps`: up to 10 steps per project, each naming a workflow, a webhook path and a point in the pipeline.
- A cached workflow list (`<data>/n8n/workflows.json`) that the UI, REST, MCP and the CLI can refresh and read.
- An opt-in check task after a workflow edit, created as a draft by default.
- The callback endpoint `POST /callbacks/external-steps/{runId}`, outside the API-key chain.

## Step points

Each step runs at one of three points. Steps at one point run in list order. An iteration runs each step once, never per fix round.

- `after-planner`: after the refinement, before the developer. Its report goes into the developer's prompt.
- `after-developer`: before the observer and the reviewer. Its report goes into their prompts and into the fix prompts.
- `after-review`: after the reviewer approves, before the worktree is finalized. Used to notify, deploy or open a ticket.

A step has an `onFailure` of `fail` (default) or `continue`. A failed step with `fail` fails the task. With `continue` it is logged and the pipeline goes on.

## Payload

boof POSTs this JSON to `<webhookBaseUrl>/<webhookPath>`:

```json
{
  "boof": { "version": "0.4.0", "kind": "step" },
  "run": {
    "id": "xr-<32 hex>",
    "callbackUrl": "<callbackBaseUrl>/callbacks/external-steps/xr-…",
    "token": "bxs_…",
    "expiresAt": "<iso>"
  },
  "step": { "id": "ci", "label": "CI", "at": "after-developer" },
  "task": {
    "project": "shop",
    "id": "fix-login",
    "title": "…",
    "prompt": "…",
    "labels": [],
    "priority": 0,
    "iteration": 1,
    "branch": "boof-runner/fix-login",
    "base": "<sha>"
  },
  "reports": { "planner": "…", "developer": "…" },
  "diff": "<only when step.sendDiff; capped at review.maxInlineDiffBytes>"
}
```

- `reports` holds what exists at that point: the final plan, the developer report, and the last reviewer report for `after-review`.
- A check task sends `boof.kind = "check"`, `step.at = "check"`, and `task` without `branch` or `base`.

## How a step runs

1. The runner opens a run in `ExternalRunStore` and gets `{ runId, token, expiresAt }`. The record stores only `sha256(token)`.
2. It POSTs the payload. The target goes through `checkWebhookTarget`, the connection is pinned to the checked addresses, redirects are not followed, and `X-Boof-Token: <webhook secret>` is sent.
   - Network errors and 5xx answers are retried with `retries.transient` and `retries.backoffMs`. A 4xx fails the attempt at once.
   - A timeout after the request was fully sent is not a failure. A webhook set to "respond when last node finishes" may answer late, so the runner keeps waiting for the callback.
3. While it waits, the step shows in the task's steps strip as `n8n: <label>`. The log says `Waiting for n8n workflow <id> (run <runId>) until <HH:MM>`. A stop request ends the wait within 1 s.
4. The n8n workflow ends with an HTTP Request node that POSTs to `run.callbackUrl` with `Authorization: Bearer <run.token>` and the body `{ "status": "ok" | "failed", "report": "<markdown, ≤ 65 536 chars>", "summary": "<≤ 300 chars, optional>" }`.
5. The server verifies the token, validates the body, closes the run with `rename` and writes the result. The runner sees the result and goes on.
   - `status: "failed"`, the step timeout (`timeoutMs`, default `settings.n8n.defaultTimeoutMs` = 30 min) and a trigger that failed after its retries all fail the step.
   - The callback can only say `ok` or `failed`. It cannot ask for changes (see open question 4).

## Callback authentication

- **Per-run token.** `bxs_` + base64url(32 random bytes), minted for one run of one step of one task. Only its sha256 hex is stored, in `<data>/external-runs/<runId>.json` (file 0600, folder 0700), with `projectId`, `taskId`, `stepId`, `kind` and `expiresAt`. The token appears only in the outbound payload. It is never logged, audited, put in events, written to the task file, `log.txt`, agent prompts or an agent's environment.
- **Scoped.** The path carries `runId` (`xr-` + 32 lowercase hex). The token must match that run's hash, compared with `timingSafeEqual`. A token for another run, task or step fails. The token is not an API key, is never looked up in `clients.json`, and cannot reach `/api` or `/mcp`.
- **Single use and replay-safe.** Completing a run is `rename(<runId>.json → <runId>.closed)`. The rename is atomic on one filesystem, so only the first caller wins. Replays, a second concurrent callback, and a callback after the runner's timeout or stop (which close the run with the same `rename`) find no open record and get `401`. The token also expires at `expiresAt`.
- **Uniform refusal.** An unknown, malformed, closed or expired run, a missing or wrong token, and a token sent in the query string all get the same `401 invalid_step_token`. The endpoint reveals nothing about which runs exist. Each refusal spends the caller's unauthenticated budget (`429` after `security.rateLimit.unauthenticatedPerMinute`).
- **Not a browser endpoint.** A request with an `Origin` or `Sec-Fetch-Site` header is `403`. The body must be `application/json` (`415`; `application/json; charset=utf-8` is accepted) and at most 300 000 bytes (`413`). A body that fails the schema is `400` and does not use up the token.
- **Independent of `auth.mode` and layer 1.** The route sits outside the API-key chain. It behaves the same under `local-trust` and `required`, from loopback, through nginx with proxy headers, and under a path prefix (the prefix lives in `callbackBaseUrl`). Without the token, a local process gets `401` like anyone else.
- **Audited.** Every callback, accepted or refused, writes one audit line `callback:external-step` with the outcome and `runId`, and, when the token verified, project, task, step and status. Never the token or the body.
- **Why a bearer token and not an HMAC signature.** n8n's HTTP Request node sets a header in one field; an HMAC needs a Code node. The secret sits in n8n's execution data either way, so a signature adds no protection. Single use, a short life and a one-run scope limit what a leak from n8n's execution history can do: complete one step that is waiting, or nothing.

## Outbound calls

- **Destinations.** Only URLs built from admin-set settings: `baseUrl` (API) and `webhookBaseUrl` (webhooks). A step holds only a webhook path, which must not contain `..`, `//`, `?`, `#` or a leading `/`. A projects-scope client therefore cannot aim boof at an arbitrary host.
- **Each call:**
  - `checkWebhookTarget`, with the same blocked ranges as webhooks, subject to the private-host rule below;
  - a connection pinned to the checked addresses (the name is never resolved twice);
  - no redirects (`redirected`);
  - timeouts of 10 s for a trigger and 30 s per API page;
  - an API response capped at 5 MB, and at most 10 pages of 100 workflows (more than 1 000 workflows is `too_many`, never a silent cut).
- **Private n8n host (owner answer 2, final).** The host:port of the configured `baseUrl` is exempt from the private-address block, automatically, so an n8n on loopback or a LAN works without listing it. The exemption is narrow:
  - it covers only API calls to that exact host:port, still pinned to the resolved address, with no redirects;
  - it never covers webhook targets or any other host, so webhook targets on a private address still need `security.allowedPrivateWebhookHosts`;
  - changing `baseUrl` drops the old exemption;
  - boof's own server address (`isSelfUrl`) is still refused as `baseUrl`.
- **Credentials.** The API key goes only to `baseUrl`'s origin, in `X-N8N-API-KEY`. The webhook secret goes only to the webhook URL, in `X-Boof-Token`.
- **Errors.** An error carries a short reason: `unauthorized`, `unreachable`, `blocked: <reason>`, `HTTP <n>`, `redirected`, `bad_response`, `too_many`. It never carries a response body, a header or a URL path. An n8n `404` on a webhook says `n8n answered 404 for workflow <id>: is it active, and is the webhook path <first 8 chars>… still right?`
- **Audit.** Every outbound call writes an audit line (`n8n:workflows.list`, `n8n:trigger`) with the host, outcome, status and time. A trigger also records project, task, step and `runId`. Error and audit text names hosts only, never URL paths, because an n8n webhook path is often a UUID that acts as a secret.

## Absence and fallback

Absent means there is no `settings.n8n` block. It is the default, and nothing about n8n runs:

- no poller and no outbound call;
- `n8n.get` answers `{ configured: false }`;
- `n8n.workflows.list` answers `{ configured: false, workflows: [] }`;
- `n8n.workflows.refresh` answers `409 n8n_not_configured`;
- the UI shows a "Connect n8n" form and hides the external-steps editor;
- a project with no `externalSteps` runs exactly today's steps.

Other cases:

- **Configured but down.** Refresh answers `502 upstream_failed` with `details.reason`, and the cached list stays. A step's trigger fails after its retries, and the step follows its `onFailure`.
- **Removed while steps still reference it.** A step whose project still lists it fails with `external step <id>: n8n is not configured` (or continues, if `onFailure` is `continue`).
- **No server to receive callbacks.** Before triggering, the transport checks that a boof server holds `webhooks/.dispatcher.lock` on this data root (`inspectProcessLock`). If none is live, the step fails at once with `external step <id>: no boof server is running on this data root to receive the n8n callback; start boof-runner serve or the desktop app`. This matters for headless `run`.
- **Restart or stop during the wait.** The run closes; a late callback gets `401`; a retry mints a new run. Records of crashed runs are pruned at `expiresAt` + 24 h, at server start and hourly.

## Check after edit

- Opt-in and off by default (`settings.n8n.checks`, owner answer 1). The poller runs only when checks are enabled.
- The server polls the workflow list every `checks.pollIntervalMs` (default 300 000, min 60 000). When a workflow's `updatedAt` changes, it creates a check task in a chosen project.
- A check task runs only that workflow, with `boof.kind = "check"` in the payload. It finishes `done` when the callback says `ok`.
- Check tasks are **drafts** unless `checks.autoQueue` is set, because running a workflow can send mail or deploy.

## What is not built

- No "run one internal step" API. A step always goes through an n8n webhook.
- No generic URL targets. A step's target is a webhook path under the admin-set n8n URL.
- No verdicts from n8n. A callback answers `ok` or `failed` only.
- No global steps and no per-task override. Steps are configured per project (`project.externalSteps`). A global default can come later without a migration.
- n8n is never started by boof.

## Parity

Every new capability is reachable through REST, MCP, the generated CLI, the web UI and the desktop app. The callback route is the one exception: it is n8n's protocol endpoint, like `/auth/browser`, and the docs say so. External steps are edited through the existing `projects.update`.

The n8n API key is a write-only field on an admin-only operation. Over MCP it is exposed as `boof_update_n8n` (owner answer 4), which needs a trusted, unrestricted admin key.

## Open questions

The owner answered all six on 2026-11-09. The answers are binding; the plan follows them.

1. **Check task after each workflow edit.** Answer: build it, off by default, drafts. (Owner answer 1.)
2. **An n8n on the same machine or a LAN.** Answer: exempt the configured n8n host automatically, narrowly, as described in "Outbound calls". This is not the recommendation, which was to list the host in `security.allowedPrivateWebhookHosts`. (Owner answer 2.)
3. **External steps to any URL.** Answer: n8n only, `ok`/`failed` only. (Owner answer 3.)
4. **May an n8n step ask for changes?** Answer: no for this version. A step answers `ok` or `failed`, and its report reaches the reviewer, who can ask for changes. (Owner answers 3 and 5/6, as recommended.)
5. **Where steps are configured.** Answer: per project only, with no per-task override and no global list. (Owner answers 5/6, as recommended.)
6. **The n8n API key over MCP.** Answer: `n8n.update` with its write-only `apiKey`, exposed as `boof_update_n8n`, on an admin-only tool. (Owner answer 4.)

One point the answers leave open, and the implementation reads as follows: the private-host exemption covers API calls only. If an n8n webhook base sits on the same private host as `baseUrl`, its webhook targets still need `security.allowedPrivateWebhookHosts`.
