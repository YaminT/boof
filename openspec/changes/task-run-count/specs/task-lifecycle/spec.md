## MODIFIED Requirements

### Requirement: State machine transitions

The system SHALL permit only these transitions: `draft → pending` (save/enqueue); `pending → running` (runner picks up); `running → pending` (re-queue for the next iteration of a multi-run task); `running → action` (planner asks questions); `action → pending` (user answers, resume); `running → done` (final run completes); `running → failed` (unrecoverable error); and `failed → pending` (user retries). Any other transition SHALL be rejected.

#### Scenario: A valid transition succeeds

- **WHEN** a `pending` task is picked up by the runner
- **THEN** the task transitions to `running` and its file moves from `tasks/pending/` to `tasks/ongoing/`

#### Scenario: Re-queue for the next iteration

- **WHEN** a multi-run task completes a run but has runs remaining
- **THEN** the task transitions `running → pending` and its file moves back to `tasks/pending/`

#### Scenario: An invalid transition is rejected

- **WHEN** a transition from `done` to `running` is attempted
- **THEN** the system SHALL reject it and leave the task unchanged

#### Scenario: Failed task is retried

- **WHEN** the user retries a `failed` task
- **THEN** the task transitions to `pending` and its file moves to `tasks/pending/`
