## ADDED Requirements

### Requirement: Command template format

A command template SHALL be a single markdown file under `commands/` with frontmatter containing `id` (kebab-case) and `name` (display string), followed by a body holding the instruction text to inject into tasks. The `id` SHALL be auto-derived from `name` using the same kebab-case derivation as task ids and SHALL be read-only in the UI.

#### Scenario: A command template is parsed

- **WHEN** a file in `commands/` with valid `id`/`name` frontmatter is read
- **THEN** the parser returns the id, name, and instruction body

#### Scenario: Id is auto-derived from name

- **WHEN** a template is created with name `Secure Feature`
- **THEN** its `id` SHALL be `secure-feature` and SHALL be presented read-only

### Requirement: Command template CRUD

The system SHALL support creating, reading, updating, and deleting command templates. Updating the instruction body SHALL persist to the template file. Deleting a template SHALL be permitted, but the system SHALL warn when the template is still referenced by one or more tasks.

#### Scenario: Editing a template body persists

- **WHEN** the user edits a template's instruction body and saves
- **THEN** the template file body is updated and its `id`/`name` are unchanged

#### Scenario: Deleting a referenced template warns

- **WHEN** the user deletes a template that is referenced by at least one task's `command` field
- **THEN** the system SHALL surface a warning identifying the affected tasks before completing the deletion

### Requirement: Rename-and-relink on id change

Editing a template's `id` directly SHALL be disallowed once the template is referenced. When the user renames a template such that its derived id changes, the system SHALL either reject the change while referenced or perform a rename-and-relink that updates the `command` field of every referencing task.

#### Scenario: Rename relinks referencing tasks

- **WHEN** a referenced template is renamed so its id changes from `secure-feature` to `harden-feature`
- **THEN** every task whose `command` was `secure-feature` SHALL be updated to `harden-feature` (or the rename SHALL be rejected with an explanatory error)

### Requirement: Template injection into tasks

Selecting a command template for a task SHALL set the task's `command` frontmatter field to the template id and inject the template's instruction body verbatim into the task's `## Command` section at save time.

#### Scenario: Selecting a template injects its body

- **WHEN** a task is saved with command template `secure-feature` selected
- **THEN** the task's `command` field is set to `secure-feature` and the `## Command` section contains the template's instruction body verbatim

#### Scenario: Clearing the command empties the section

- **WHEN** a task is saved with no command template selected
- **THEN** the task's `command` field is `null` and the `## Command` section contains no injected instructions
