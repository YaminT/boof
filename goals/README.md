# Goals

The backlog of boof-runner, in boof's own format: one `goal.boof.xml` per unit under `goals/<id>/` and the order plus dependencies in [`plan.boof.xml`](../plan.boof.xml) at the repository root (the scanner reads the plan there). `<version>` entries record the status (`plan` → `develop` → `review` → `done`); the highest number is current.

Run them with boof itself:

```bash
boof-runner scan ~/code/boof --dry-run      # list what would become a task
boof-runner plan import --project boof      # or: import into the project's plan and sync from the UI
```

When a task finishes, boof appends the new status to the goal file (`planWriteBack`). Tick the box here when a goal is `done`.

## Runner

- [x] [`real-tools-parse-questions`](real-tools-parse-questions/goal.boof.xml) — Real tool adapters must surface planner questions (park flow is mock-only)
- [x] [`running-task-edits-survive`](running-task-edits-survive/goal.boof.xml) — Edits to a running task survive the run (no stale overwrite)
- [x] [`task-store-atomicity`](task-store-atomicity/goal.boof.xml) — TaskStore transitions and create are atomic (no task in two status dirs)
- [x] [`shutdown-fill-race`](shutdown-fill-race/goal.boof.xml) — No task starts after shutdown() began
- [ ] [`orphan-agent-processes`](orphan-agent-processes/goal.boof.xml) — Record agent process groups and reap orphans on recovery (after: desktop-graceful-quit)
- [x] [`prompt-via-stdin-for-codex-opencode`](prompt-via-stdin-for-codex-opencode/goal.boof.xml) — Pass large prompts to codex/opencode without hitting argv limits
- [x] [`usage-ledger-accuracy`](usage-ledger-accuracy/goal.boof.xml) — Usage ledger: codex cost is unknown, failed attempts are not recorded
- [x] [`git-worktree-add-timeout`](git-worktree-add-timeout/goal.boof.xml) — Do not SIGKILL slow `git worktree add`; clean up a failed add
- [x] [`reject-nested-projects-same-repo`](reject-nested-projects-same-repo/goal.boof.xml) — Reject two projects rooted in the same git repository
- [x] [`review-diff-includes-untracked`](review-diff-includes-untracked/goal.boof.xml) — Observer and reviewer see the content of new (untracked) files
- [ ] [`questions-from-any-role`](questions-from-any-role/goal.boof.xml) — Route the planner's answers back to a developer, observer or reviewer that asked questions

## Security

- [ ] [`webhook-secrets-at-rest`](webhook-secrets-at-rest/goal.boof.xml) — Protect webhook secrets at rest (after: migration-lock)
- [x] [`client-create-inherits-restrictions`](client-create-inherits-restrictions/goal.boof.xml) — auth.clients.create cannot escalate projects or expiry
- [x] [`command-templates-respect-project-scope`](command-templates-respect-project-scope/goal.boof.xml) — Command templates respect project restrictions
- [ ] [`sse-principal-revocation`](sse-principal-revocation/goal.boof.xml) — Event streams stop when the key is revoked
- [ ] [`rate-limit-unauthenticated-and-healthz`](rate-limit-unauthenticated-and-healthz/goal.boof.xml) — Rate limit unauthenticated requests and cache /healthz
- [ ] [`csrf-content-type-and-origin`](csrf-content-type-and-origin/goal.boof.xml) — CSRF defence for the local-trust principal
- [x] [`inject-and-stop-respect-trust`](inject-and-stop-respect-trust/goal.boof.xml) — tasks.inject and tasks.stop respect the trust level
- [ ] [`webhook-ssrf-guard`](webhook-ssrf-guard/goal.boof.xml) — Webhook URLs reject loopback, link-local and private addresses

## Correctness and robustness

- [ ] [`idempotency-key-concurrency`](idempotency-key-concurrency/goal.boof.xml) — Serialize concurrent requests with the same Idempotency-Key
- [x] [`migration-lock`](migration-lock/goal.boof.xml) — Guard the v1 to v2 data migration against two processes
- [ ] [`cancel-waits-on-disconnect`](cancel-waits-on-disconnect/goal.boof.xml) — Cancel long waits when the client disconnects
- [x] [`plan-approval-backfill`](plan-approval-backfill/goal.boof.xml) — Backfill approval for plans activated before approvedBy existed (after: migration-lock)
- [x] [`prune-worktrees-on-project-add`](prune-worktrees-on-project-add/goal.boof.xml) — Prune stale worktrees when a project is added or unarchived
- [x] [`mcp-listchanged-and-log-tail`](mcp-listchanged-and-log-tail/goal.boof.xml) — MCP: drop listChanged in stateless mode, add tail to the task log tool
- [ ] [`desktop-graceful-quit`](desktop-graceful-quit/goal.boof.xml) — Desktop quit must shut the engine down gracefully
- [ ] [`service-install-keeps-options`](service-install-keeps-options/goal.boof.xml) — service install keeps previously configured options
- [ ] [`cli-version-and-unknown-command`](cli-version-and-unknown-command/goal.boof.xml) — Add --version and stop unknown commands from starting the server
- [ ] [`desktop-healthz-facts`](desktop-healthz-facts/goal.boof.xml) — Desktop server reports version and runner state on /healthz
- [x] [`task-file-heading-escape`](task-file-heading-escape/goal.boof.xml) — Task markdown round-trip survives section headings in prompt, reports and log
- [x] [`store-update-under-lock`](store-update-under-lock/goal.boof.xml) — SettingsStore.update and ProjectStore.update read-modify-write under the lock
- [x] [`plan-goal-path-uniqueness`](plan-goal-path-uniqueness/goal.boof.xml) — Plan validation normalises and de-duplicates goal paths
- [x] [`atomic-write-lock-map-and-fsync`](atomic-write-lock-map-and-fsync/goal.boof.xml) — withFileLock frees its map entries; atomicWrite fsyncs

## Server

- [ ] [`attachment-upload-no-json-fingerprint`](attachment-upload-no-json-fingerprint/goal.boof.xml) — Do not JSON-fingerprint attachment uploads
- [ ] [`audit-forwarded-ip`](audit-forwarded-ip/goal.boof.xml) — Audit log records the forwarded client address behind a proxy
- [ ] [`security-headers-behind-proxy`](security-headers-behind-proxy/goal.boof.xml) — HSTS and CORP headers fit a TLS-terminating proxy and public docs
- [x] [`mcp-resources-degrade-by-scope`](mcp-resources-degrade-by-scope/goal.boof.xml) — MCP resources/list degrades to empty for keys without projects:read

## Install and release

- [ ] [`fix-npm-install-path`](fix-npm-install-path/goal.boof.xml) — Make npm-only installs work (workspace:* protocol, copy mode externals)
- [ ] [`release-workflow-version`](release-workflow-version/goal.boof.xml) — Release workflow derives the app version and prerelease flag from the tag

## Web UI

- [x] [`ui-drag-reorder-goals`](ui-drag-reorder-goals/goal.boof.xml) — Drag-and-drop reorder of plan goals (merged into ui-redesign-phase-4)
- [x] [`ui-linkable-tabs`](ui-linkable-tabs/goal.boof.xml) — Linkable Settings, Commands and Actions tabs (merged into ui-redesign-phase-5)
- [ ] [`ui-archived-projects`](ui-archived-projects/goal.boof.xml) — List archived projects and allow unarchive or delete
- [x] [`ui-project-overrides`](ui-project-overrides/goal.boof.xml) — Project overrides for review, worktree, retries and budget in the UI (merged into ui-redesign-phase-5)
- [ ] [`ui-return-to-plan`](ui-return-to-plan/goal.boof.xml) — Return to the plan after opening a task from it (after: ui-linkable-tabs)
- [x] [`ui-settings-form-keeps-edits`](ui-settings-form-keeps-edits/goal.boof.xml) — Settings page keeps unsaved edits across live refreshes (merged into ui-redesign-phase-5)
- [ ] [`ui-optimistic-concurrency`](ui-optimistic-concurrency/goal.boof.xml) — UI honours optimistic concurrency for goals and tasks
- [ ] [`ui-surface-action-errors`](ui-surface-action-errors/goal.boof.xml) — Task-row and command actions surface failures
- [ ] [`ui-a11y-reorder-and-modals`](ui-a11y-reorder-and-modals/goal.boof.xml) — Keyboard task reorder and focus-managed modals (after: ui-drag-reorder-goals)
- [x] [`ui-clients-rotate-and-scopes`](ui-clients-rotate-and-scopes/goal.boof.xml) — Clients UI can rotate keys and grant every scope (merged into ui-redesign-phase-5)

## Docs

- [ ] [`docs-consistency-pass`](docs-consistency-pass/goal.boof.xml) — Docs consistency pass (budgets, MCP tool count, Node floor, clone URL, desktop first run)

## Product direction (owner, 2026-10-29)

- [ ] [`owlish-accounts`](owlish-accounts/goal.boof.xml) — Bring better-ccflare's main features into boof: Claude, ChatGPT and other accounts, a harness boof controls (research first)
- [ ] [`task-hierarchy`](task-hierarchy/goal.boof.xml) — Project → epic (optional) → task → subtask (optional), every level with a priority
- [ ] [`ui-minimum-expandable-interface`](ui-minimum-expandable-interface/goal.boof.xml) — A simple panel first, expandable to the complex one; complexity stays in the backend
- [ ] [`project-create-with-path`](project-create-with-path/goal.boof.xml) — Create a project with a new, existing or automatic path, starting with a brief (after: chat-console)
- [ ] [`chat-console`](chat-console/goal.boof.xml) — A terminal-like chat box at the bottom of every page that talks to the page (after: owlish-accounts)
- [ ] [`n8n-pipelines`](n8n-pipelines/goal.boof.xml) — Low priority: n8n can run boof's process; boof works with or without it; each workflow edit adds a check task

## UI redesign, remaining (2026-10-29)

- [ ] [`ui-phase-3-residuals`](ui-phase-3-residuals/goal.boof.xml) — Three small regressions left by the phase 3 fix wave
- [ ] [`ui-redesign-phase-4`](ui-redesign-phase-4/goal.boof.xml) — Plans screen and the Inbox / Needs-you group
- [ ] [`ui-redesign-phase-5`](ui-redesign-phase-5/goal.boof.xml) — Settings in five pages, API keys, budgets (after: ui-redesign-phase-4)
- [ ] [`ui-redesign-phase-6`](ui-redesign-phase-6/goal.boof.xml) — Polish, a11y, remove styles.css, bundle size, deferred minors (after: ui-redesign-phase-5)
- [x] [`step-closing-entry`](step-closing-entry/goal.boof.xml) — Owner decision: a closing entry in steps[] so the last step has a duration
- [ ] [`boof-split`](boof-split/goal.boof.xml) — Separate Runner, Facedisk, Heart and Owlish with boof as the orchestrator (design first)

## Verification and release

- [ ] [`verify-steering-codex`](verify-steering-codex/goal.boof.xml) — Verify live steering (inject mode now) with Codex
- [ ] [`desktop-e2e`](desktop-e2e/goal.boof.xml) — Test the desktop app end to end
- [ ] [`typescript-7`](typescript-7/goal.boof.xml) — Upgrade to TypeScript 7
- [ ] [`publish-runbook`](publish-runbook/goal.boof.xml) — Publish the server runbook on nodets.com
- [ ] [`release-0-3-0`](release-0-3-0/goal.boof.xml) — Release v0.3.0 with a changelog (after: desktop-e2e, verify-steering-codex, publish-runbook)
