## ADDED Requirements

### Requirement: Background runner loop

The system SHALL run a background process that polls `tasks/pending/` for eligible work. The runner SHALL start after install and whenever the app/CLI launches, and SHALL NOT register an OS boot service (no autostart on machine restart).

#### Scenario: Runner picks up a queued task

- **WHEN** the runner is enabled and a task exists in `tasks/pending/` with `skip: false`
- **THEN** the runner selects it and begins the pipeline

#### Scenario: Runner does not autostart on reboot

- **WHEN** the machine restarts
- **THEN** the runner does not start on its own; it starts only when the user launches the app/CLI

### Requirement: Selection order and concurrency

The runner SHALL consider only `pending` tasks with `skip: false`, ordered by `priority` descending (higher runs sooner), with `updated`/insertion order as a tiebreak. The runner SHALL process one task at a time by default.

#### Scenario: Higher priority runs first

- **WHEN** two eligible tasks have priorities 80 and 50
- **THEN** the priority-80 task is selected first

#### Scenario: Skipped tasks are excluded

- **WHEN** the highest-priority pending task has `skip: true`
- **THEN** it is not selected and the runner considers the next eligible task

#### Scenario: One task at a time

- **WHEN** a task is already `running`
- **THEN** the runner does not start a second task concurrently

### Requirement: Runtime on/off control

The runner SHALL be controlled by `settings.runner.enabled`. When disabled, the runner SHALL finish the in-flight step gracefully and SHALL NOT start further steps or select new tasks. When re-enabled, it SHALL resume selecting work.

#### Scenario: Disabling finishes the current step

- **WHEN** `runner.enabled` is set to `false` while a step is executing
- **THEN** the current step completes, no further step is started, and no new task is selected

#### Scenario: Re-enabling resumes work

- **WHEN** `runner.enabled` returns to `true`
- **THEN** the runner resumes selecting eligible pending tasks

### Requirement: Block hours idling

The runner SHALL idle during configured block hours. In this iteration `blockHours` is a placeholder that defaults to empty (never idle).

#### Scenario: Empty block hours never idle

- **WHEN** `blockHours` is empty
- **THEN** the runner never idles for block-hour reasons

### Requirement: Per-task working area

On picking a task, the runner SHALL move it to `tasks/ongoing/<task-id>/`, set `status: running`, and create the working area: `task.md` (the moved task file), `plan.md`, `reports/{planner,developer,reviewer}.md`, and `log.txt` for raw tool stdout/stderr. The command-template definition SHALL be present in the task file.

#### Scenario: Working area is created on start

- **WHEN** the runner starts a task
- **THEN** `tasks/ongoing/<task-id>/` exists containing `task.md`, a `reports/` directory, and `log.txt`, and the task's `status` is `running`

### Requirement: Planner, refinement, developer, reviewer pipeline

The runner SHALL drive each task through four steps in order: (1) planner produces an implementation plan into `plan.md` in auto mode; (2) a planner refinement pass reads repo context plus `plan.md` and adjusts the plan; (3) the developer implements changes in the task worktree based on the task and `plan.md`; (4) the reviewer reviews the resulting diff/code. Every step SHALL write a report under `reports/`. On full success the task SHALL move to `tasks/done/` with `status: done`.

#### Scenario: Pipeline runs all steps and completes

- **WHEN** a task runs to completion with no questions or errors (mock tool)
- **THEN** `plan.md` is written, all four reports are produced, and the task ends in `tasks/done/` with `status: done`

#### Scenario: Refinement pass adjusts the plan

- **WHEN** the planner refinement pass runs after the initial plan
- **THEN** it reads `plan.md` plus repo context and writes an updated plan, and a planner report records the refinement

#### Scenario: Reports feed downstream steps

- **WHEN** the developer step runs
- **THEN** it receives the task prompt, the injected command, and the refined `plan.md` as input; and the reviewer step receives the resulting diff/code

### Requirement: Planner questions park-and-continue loop

When the planner raises clarifying questions, the runner SHALL append them to the task's `## Questions` section, set `questions: pending`, move the task to `tasks/actions/` with `status: action`, and stop that task. The runner SHALL continue processing other eligible tasks. When the user answers, the task SHALL move back to `tasks/pending/` and resume.

#### Scenario: Planner question parks the task

- **WHEN** the planner step returns a non-empty `questions` array
- **THEN** the questions are written to `## Questions`, `questions` becomes `pending`, the task moves to `tasks/actions/` with `status: action`, and that task stops

#### Scenario: Runner continues other work while parked

- **WHEN** one task is parked in `actions/` awaiting answers
- **THEN** the runner is free to select and run another eligible pending task

#### Scenario: Answered task resumes

- **WHEN** the user submits answers and the task returns to `pending` with `questions: answered`
- **THEN** the runner resumes the pipeline for that task and does not re-prompt the already-answered questions

### Requirement: Developer/reviewer questions routed to planner

The developer and reviewer SHALL be instructed not to ask the user questions unless in genuine doubt. When they do raise a question, it SHALL be routed to the planner and answered via a written back-and-forth in the task directory, never surfaced to the user. Only the planner escalates questions to the user.

#### Scenario: Developer question goes to the planner

- **WHEN** the developer step raises a question
- **THEN** the question is recorded in the task directory and answered by a planner session via file, without parking the task for user input

### Requirement: Failure handling and retry

A tool crash, non-zero exit, or timeout with no recoverable output SHALL move the task to `tasks/failed/` with `status: failed` and capture diagnostics in `log.txt`. The user SHALL be able to retry a failed task, returning it to `pending`.

#### Scenario: Tool crash fails the task

- **WHEN** a pipeline step's tool exits non-zero with no recoverable output
- **THEN** the task moves to `tasks/failed/` with `status: failed` and `log.txt` contains the captured diagnostics

#### Scenario: Failed task can be retried

- **WHEN** the user retries a failed task
- **THEN** the task returns to `tasks/pending/` with `status: pending` and becomes eligible for selection again
