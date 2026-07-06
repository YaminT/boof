## MODIFIED Requirements

### Requirement: Task editor

The UI SHALL provide a markdown editor for the task's `## Prompt` body, a priority field, a **runs** field (integer ≥ 1, default 1, controlling how many times the pipeline runs), and a command-template selector. Saving SHALL write the file per the task-file format, setting `skip`, `status` (including `draft`), `command`, `runs`, and injecting the selected template into `## Command`.

#### Scenario: Saving writes the prompt and command

- **WHEN** the user edits the prompt, selects a command template, and saves
- **THEN** the task file is written with the new prompt body, `command` set, and the template injected into `## Command`

#### Scenario: Editing priority persists

- **WHEN** the user changes the priority field and saves
- **THEN** the task's `priority` frontmatter is updated

#### Scenario: Setting the run count persists

- **WHEN** the user sets Runs to 3 and saves
- **THEN** the task's `runs` frontmatter is 3, and a run count below 1 is clamped to 1

## ADDED Requirements

### Requirement: Run progress indicator

The task list SHALL show run progress (`completedRuns/runs`) for any task whose `runs` is greater than 1, so the user can see how many passes remain.

#### Scenario: Multi-run task shows progress

- **WHEN** a task with `runs: 3` has completed 1 run
- **THEN** the task list displays its progress as `1/3`

#### Scenario: Single-run task shows no indicator

- **WHEN** a task has `runs: 1`
- **THEN** no run-progress indicator is shown for it
