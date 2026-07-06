## ADDED Requirements

### Requirement: Per-task token usage capture

The system SHALL capture token usage and estimated cost for each pipeline step from the tool's output where available, and aggregate it per task. Usage SHALL be persisted alongside the task's orchestration artifacts.

#### Scenario: Step usage is recorded

- **WHEN** a pipeline step completes and its tool output reports token counts
- **THEN** the step's token usage and estimated cost are recorded against the task

#### Scenario: Missing usage degrades gracefully

- **WHEN** a tool's output reports no token information
- **THEN** the system records zero/unknown usage for that step without failing the pipeline

### Requirement: Global usage aggregation

The system SHALL maintain a global aggregate of token usage and estimated cost across all tasks, derivable from per-task records.

#### Scenario: Global total reflects task totals

- **WHEN** two tasks have recorded usage
- **THEN** the global aggregate equals the sum of their per-task usage

### Requirement: Usage display, no enforcement

The system SHALL surface per-task and global usage/cost in the UI. In this iteration the system SHALL NOT enforce budgets or pause the runner based on usage.

#### Scenario: Usage is shown in the UI

- **WHEN** the user views a completed task and the settings/usage view
- **THEN** the per-task usage/cost and the global aggregate are displayed

#### Scenario: Usage does not gate the runner

- **WHEN** recorded usage grows arbitrarily large
- **THEN** the runner continues to select and run tasks (no budget cap is enforced)
