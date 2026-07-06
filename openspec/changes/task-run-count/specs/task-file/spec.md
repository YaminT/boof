## ADDED Requirements

### Requirement: Run-count frontmatter fields

Task frontmatter SHALL include a `runs` field (integer ≥ 1, default 1) recording how many times the user wants the pipeline to run, and a `completedRuns` field (integer ≥ 0, default 0) recording how many runs have completed. Both SHALL be validated by the `zod` schema and SHALL default when absent so existing task files remain valid.

#### Scenario: Defaults applied to a file without the fields

- **WHEN** a task file lacking `runs`/`completedRuns` is parsed
- **THEN** `runs` defaults to 1 and `completedRuns` defaults to 0

#### Scenario: Run count is validated

- **WHEN** a task is written with `runs` set to 0 or a negative number
- **THEN** validation SHALL reject it (minimum is 1)

#### Scenario: Round-trip preserves run fields

- **WHEN** a task with `runs: 3` and `completedRuns: 1` is serialized and re-parsed
- **THEN** both values are preserved
