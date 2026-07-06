## ADDED Requirements

### Requirement: Settings file schema

The system SHALL store configuration in a single `settings.json` at the data root, validated against a `zod` schema. The schema SHALL include: `runner.enabled` (boolean), `workingDirectory` (absolute path string), `selectedSubdirectory` (string or null), `blockHours` (array, placeholder), `tokens` (object), `roles` mapping each of `planner|developer|reviewer` to `{ tool, model }`, and `models` mapping each tool id to an array of model name strings.

#### Scenario: Valid settings are loaded

- **WHEN** a `settings.json` matching the schema is read
- **THEN** the system returns a typed settings object with all fields populated

#### Scenario: Invalid settings are rejected

- **WHEN** `settings.json` omits a required field such as `roles.planner`
- **THEN** validation SHALL fail with an error identifying the missing field

### Requirement: Role assignment

Settings SHALL assign each pipeline role (planner, developer, reviewer) a tool id and a model. These global assignments SHALL apply to any task that does not provide its own `tools` override in frontmatter.

#### Scenario: Global role assignment applies by default

- **WHEN** a task without a `tools` override is run
- **THEN** each role uses the tool and model configured in `settings.roles`

#### Scenario: Per-task override takes precedence

- **WHEN** a task provides a `tools` override for the developer role
- **THEN** the developer step uses the override's tool/model rather than the global setting

### Requirement: Per-tool model lists

Settings SHALL maintain a list of available models per tool, seeded with predefined defaults and extensible by the user. The role selectors SHALL offer the models for the currently selected tool.

#### Scenario: User adds a model

- **WHEN** the user adds a new model name under a tool's model list and saves
- **THEN** the new model is persisted and becomes selectable for roles using that tool

### Requirement: Watched configuration

The settings file SHALL be watched so that changes take effect without restarting the runner. Updating `runner.enabled` SHALL be observed by the runner; updating other settings SHALL be picked up on the next selection cycle.

#### Scenario: Runner flag change is observed

- **WHEN** `settings.runner.enabled` is flipped from `true` to `false` while the runner is idle
- **THEN** the runner observes the change and stops selecting new tasks
