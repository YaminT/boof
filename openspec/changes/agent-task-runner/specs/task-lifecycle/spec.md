## ADDED Requirements

### Requirement: Status directories mirror status field

Tasks SHALL be stored under a status directory whose name corresponds to the task's `status`: `tasks/drafts/` (`draft`), `tasks/pending/` (`pending`), `tasks/ongoing/` (`running`), `tasks/actions/` (`action`), `tasks/done/` (`done`), and `tasks/failed/` (`failed`). The directory a task lives in SHALL always match its `status` frontmatter field.

#### Scenario: A pending task lives in the pending directory

- **WHEN** a task has `status: pending`
- **THEN** its file resides under `tasks/pending/`

#### Scenario: Status and directory are reconciled on read

- **WHEN** a task file's `status` field disagrees with the directory it is found in
- **THEN** the system SHALL treat the directory location as the operation that follows the status change and move/repair the file so the two agree

### Requirement: State machine transitions

The system SHALL permit only these transitions: `draft → pending` (save/enqueue); `pending → running` (runner picks up); `running → action` (planner asks questions); `action → pending` (user answers, resume); `running → done` (pipeline completes); `running → failed` (unrecoverable error); and `failed → pending` (user retries). Any other transition SHALL be rejected.

#### Scenario: A valid transition succeeds

- **WHEN** a `pending` task is picked up by the runner
- **THEN** the task transitions to `running` and its file moves from `tasks/pending/` to `tasks/ongoing/`

#### Scenario: An invalid transition is rejected

- **WHEN** a transition from `done` to `running` is attempted
- **THEN** the system SHALL reject it and leave the task unchanged

#### Scenario: Failed task is retried

- **WHEN** the user retries a `failed` task
- **THEN** the task transitions to `pending` and its file moves to `tasks/pending/`

### Requirement: Status change moves the file atomically

Changing a task's status SHALL update the `status` frontmatter field and move the file to the matching status directory as a coordinated operation (write file, then move), so observers always see a consistent file in a consistent location.

#### Scenario: Move follows write

- **WHEN** a task transitions from `pending` to `running`
- **THEN** the file is first written with `status: running` and then moved into `tasks/ongoing/`, never the reverse order

### Requirement: Skip is orthogonal to status

The `skip` flag SHALL be an independent boolean that does not change a task's status or directory. A skipped task SHALL retain its current status and location but SHALL be excluded from runner selection.

#### Scenario: Skipping a pending task leaves it in place

- **WHEN** the `skip` flag of a `pending` task is set to `true`
- **THEN** the task keeps `status: pending`, stays in `tasks/pending/`, and is not selected by the runner
