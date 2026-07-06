## ADDED Requirements

### Requirement: CLI bin entry boots web and runner

The system SHALL provide a `bin` CLI entry, runnable via `bunx`/`npx`, that boots the web server and ensures the background runner is running. The package SHALL be structured for npm packaging but SHALL NOT be published in this iteration.

#### Scenario: CLI starts the system

- **WHEN** the CLI entry is invoked
- **THEN** the web server starts on a localhost port and the runner process is ensured running

#### Scenario: Runner is not duplicated

- **WHEN** the CLI is invoked while a runner is already running
- **THEN** it does not start a second competing runner

### Requirement: First-run scaffolding

On first run the CLI SHALL scaffold the data root: the `tasks/` status directories (`drafts/`, `pending/`, `ongoing/`, `actions/`, `done/`, `failed/`), a `commands/` directory, and a default `settings.json` validated against the settings schema.

#### Scenario: Fresh data root is created

- **WHEN** the CLI runs against a data root that does not yet exist
- **THEN** it creates the status directories, the `commands/` directory, and a valid default `settings.json`

#### Scenario: Existing data root is preserved

- **WHEN** the CLI runs against an existing data root
- **THEN** it does not overwrite existing tasks, commands, or settings

### Requirement: Configurable data root

The data root SHALL default to a known location but be configurable, so the user can point the app at a different task/data directory.

#### Scenario: Custom data root is honored

- **WHEN** the CLI is given a custom data-root path
- **THEN** all tasks, commands, and settings are read from and written to that path

### Requirement: Bun/Node runtime adapter

Shared and runner code SHALL avoid Bun-only APIs or hide them behind a thin runtime adapter, so the same code runs on both Bun and Node.js ≥ 20.

#### Scenario: Runtime-specific calls go through the adapter

- **WHEN** code needs a capability that differs between Bun and Node
- **THEN** it uses the runtime adapter rather than calling a Bun-only API directly, and the code runs on both runtimes
