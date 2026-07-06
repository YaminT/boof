## ADDED Requirements

### Requirement: Task file structure

A task SHALL be a single markdown file consisting of a YAML frontmatter block followed by a markdown body. The frontmatter SHALL be the canonical machine-readable store. The body SHALL contain the fixed sections `## Prompt`, `## Command`, `## Questions`, `## Answers`, and `## Reports` (with `### Planner`, `### Developer`, `### Reviewer` subsections), in that order.

#### Scenario: A well-formed task file is parsed

- **WHEN** a task file with valid frontmatter and the standard body sections is read
- **THEN** the parser returns a structured object exposing every frontmatter field and the text content of each body section

#### Scenario: A task file is missing a required body section

- **WHEN** a task file is read whose body lacks one of the fixed sections
- **THEN** the parser SHALL treat that section's content as empty rather than failing, and serialization SHALL re-add the missing section header

### Requirement: Frontmatter schema validation

Every task file read or write SHALL be validated against a `zod` schema. The schema SHALL require: `id` (kebab-case string), `title` (string), `status` (one of `draft|pending|running|action|done|failed`), `priority` (integer), `skip` (boolean), `labels` (string array), `command` (kebab-case string or null), `questions` (one of `none|pending|answered`), `created` and `updated` (ISO-8601 timestamps), and an optional `tools` object mapping each of `planner|developer|reviewer` to `{ tool, model }`.

#### Scenario: Invalid frontmatter is rejected

- **WHEN** a task file is read whose `status` value is not one of the allowed enum values
- **THEN** validation SHALL fail with an error identifying the offending field, and the file SHALL NOT be treated as a valid task

#### Scenario: Optional per-task tools override is accepted

- **WHEN** a task file includes a `tools` block assigning a different tool/model to a role
- **THEN** validation SHALL pass and the override SHALL be exposed on the parsed task object

### Requirement: Deterministic id generation

The system SHALL derive a task `id` from its title by lowercasing, replacing whitespace with hyphens, and stripping characters that are not `[a-z0-9-]`. When a derived id collides with an existing task id, the system SHALL append a numeric suffix (`-2`, `-3`, …) to produce a unique id.

#### Scenario: Title is converted to a kebab-case id

- **WHEN** a task is created with the title `Add User Authentication!`
- **THEN** the generated id SHALL be `add-user-authentication`

#### Scenario: Colliding ids are made unique

- **WHEN** a new task derives the id `add-auth` but a task with id `add-auth` already exists
- **THEN** the new task SHALL receive a unique id such as `add-auth-2`

### Requirement: Atomic, locked writes

The system SHALL write task files atomically by writing to a temporary file and renaming it over the target. Every write SHALL be guarded by a per-file lock so that concurrent writers (web server and runner) cannot interleave or clobber one another.

#### Scenario: Round-trip preserves content

- **WHEN** a task file is parsed and then serialized without modification
- **THEN** the serialized output SHALL parse back to an equivalent task object (frontmatter fields and body sections preserved)

#### Scenario: Concurrent writes do not corrupt the file

- **WHEN** two writers attempt to write the same task file at the same time
- **THEN** the lock SHALL serialize the writes and the resulting file SHALL be a complete, valid task file (no partial/interleaved content)

#### Scenario: `updated` timestamp is refreshed on write

- **WHEN** a task is written with changed content
- **THEN** the `updated` frontmatter field SHALL be set to the current time while `created` is preserved
