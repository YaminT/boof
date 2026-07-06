## ADDED Requirements

### Requirement: HTTP server runs on Bun and Node

The system SHALL provide an HTTP server that serves the built web UI and exposes the API. The server SHALL run on both Bun and Node.js ≥ 20, binding to `localhost` only (single local user, no auth).

#### Scenario: Server boots on either runtime

- **WHEN** the server is started under Bun or under Node ≥ 20
- **THEN** it binds to a localhost port and serves the UI and API

### Requirement: File-backed task API

The server SHALL expose a REST API over tasks that reads and writes the underlying task files. It SHALL support listing tasks, reading a task, creating/saving a task (with validation, atomic write, status/directory sync), toggling `skip`, reordering priorities, retrying a failed task, and submitting answers for a parked task.

#### Scenario: Listing tasks reflects the filesystem

- **WHEN** a client requests the task list
- **THEN** the response includes every task across all status directories with its frontmatter fields

#### Scenario: Saving an invalid task is rejected

- **WHEN** a client submits a task that fails schema validation
- **THEN** the API responds with an error and does not write the file

#### Scenario: Reorder rewrites priorities

- **WHEN** a client submits a new ordering of tasks
- **THEN** the API rewrites the `priority` field on the affected task files to reflect the new order

### Requirement: Command and settings API

The server SHALL expose endpoints to list/create/update/delete command templates and to read/update `settings.json` (including the runner on/off flag, working directory, role/model assignments, and model lists), all validated and atomically written.

#### Scenario: Toggling the runner flag persists

- **WHEN** a client flips the runner on/off setting
- **THEN** `settings.runner.enabled` is updated in `settings.json`

#### Scenario: Health check endpoint reports tools

- **WHEN** a client requests tool health
- **THEN** the API runs each tool's `detect()` and returns per-tool availability

### Requirement: Live updates via file watch

The server SHALL watch the data root with `chokidar` and push live updates to connected browsers via SSE so that status changes, new tasks, and answered questions appear without manual refresh.

#### Scenario: File change pushes an update

- **WHEN** a task file is created, moved, or modified on disk (e.g. by the runner)
- **THEN** the server emits an SSE event and connected clients receive the update without polling
