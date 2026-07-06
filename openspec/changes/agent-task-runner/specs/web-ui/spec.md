## ADDED Requirements

### Requirement: Task list home

The UI SHALL present a task list showing each task's title, `status` badge, `priority`, `labels`, and a `skip` checkbox. The list SHALL support drag-and-drop reordering that rewrites `priority`, immediate `skip` toggling, filtering/grouping by label, and clicking a task to open it in the editor. The list SHALL update live as files change.

#### Scenario: Drag-and-drop rewrites priority

- **WHEN** the user drags a task to a new position in the list
- **THEN** the affected tasks' `priority` values are rewritten to reflect the new order and the change persists

#### Scenario: Skip toggle persists immediately

- **WHEN** the user toggles a task's `skip` checkbox
- **THEN** the task file's `skip` field is updated immediately

#### Scenario: Grouping by label

- **WHEN** the user groups by a label
- **THEN** the list is organized so tasks carrying that label are grouped together

#### Scenario: Live status update

- **WHEN** the runner changes a task's status on disk
- **THEN** the task's status badge updates in the list without a manual refresh

### Requirement: Task editor

The UI SHALL provide a markdown editor for the task's `## Prompt` body, a priority field, and a command-template selector. Saving SHALL write the file per the task-file format, setting `skip`, `status` (including `draft`), and `command` and injecting the selected template into `## Command`.

#### Scenario: Saving writes the prompt and command

- **WHEN** the user edits the prompt, selects a command template, and saves
- **THEN** the task file is written with the new prompt body, `command` set, and the template injected into `## Command`

#### Scenario: Editing priority persists

- **WHEN** the user changes the priority field and saves
- **THEN** the task's `priority` frontmatter is updated

### Requirement: Command tab

The UI SHALL provide a Command tab listing command templates with create/edit/delete. Each template shows its `name` and a read-only auto-derived `id`. Editing the instruction body updates the template.

#### Scenario: Creating a template

- **WHEN** the user creates a template named `Secure Feature` and saves
- **THEN** a template with id `secure-feature` (read-only) and the entered body is persisted

### Requirement: Actions tab

The UI SHALL provide an Actions tab listing tasks with `questions: pending`, rendering each task's `## Questions` section for the user to answer. On submit, the answers SHALL be written to `## Answers`, `questions` SHALL be set to `answered`, and the task SHALL move back to `pending` to resume.

#### Scenario: Answering a parked task resumes it

- **WHEN** the user answers a parked task's questions and submits
- **THEN** the answers are written to `## Answers`, `questions` becomes `answered`, and the task returns to `pending`

#### Scenario: Only pending-question tasks are listed

- **WHEN** a task has `questions: none` or `questions: answered`
- **THEN** it does not appear in the Actions tab

### Requirement: Runner on/off toggle

The UI SHALL present a prominent toggle that flips `settings.runner.enabled`. The toggle SHALL reflect the current runner state.

#### Scenario: Toggling off stops new work

- **WHEN** the user switches the runner toggle off
- **THEN** `settings.runner.enabled` is set to `false` and the toggle reflects the off state

### Requirement: Settings page

The UI SHALL provide a Settings page with: a working-directory field plus a subdirectory picker; per-tool health-check status; planner/developer/reviewer role selectors (tool + model, with the ability to add models); a token usage/cost display; and placeholder cards for block hours and a better-ccflare installation suggestion.

#### Scenario: Selecting a working directory and subdirectory

- **WHEN** the user sets the working directory and picks a subdirectory under it
- **THEN** `workingDirectory` and `selectedSubdirectory` are persisted in settings

#### Scenario: Health check status is shown

- **WHEN** the Settings page loads
- **THEN** each configured tool's availability is displayed from its health check

#### Scenario: Assigning roles

- **WHEN** the user assigns a tool and model to the developer role and saves
- **THEN** `settings.roles.developer` is updated accordingly

#### Scenario: Placeholder cards are present

- **WHEN** the Settings page is viewed
- **THEN** block-hours and better-ccflare suggestion cards are shown as placeholders
