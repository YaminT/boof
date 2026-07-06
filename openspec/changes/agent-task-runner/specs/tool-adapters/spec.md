## ADDED Requirements

### Requirement: Tool interface

The system SHALL define a `Tool` interface exposing `id`, `displayName`, `defaultModels`, a `detect()` health check, and a `run(opts)` method. `run` SHALL accept `{ role, model, systemPrompt, prompt, cwd, autoApprove }` and resolve to `{ output, report, questions? }`. New tools SHALL be addable by implementing this interface without modifying the pipeline.

#### Scenario: A tool is registered and selectable

- **WHEN** a new tool implementing the `Tool` interface is registered
- **THEN** it appears in role selectors and can be assigned to any role without changes to the pipeline code

#### Scenario: run returns structured output

- **WHEN** a tool's `run` completes successfully
- **THEN** it resolves with an `output` string, a `report` string, and optionally a `questions` array

### Requirement: Built-in claude-code and codex adapters

The system SHALL ship adapters for `claude-code` and `codex`. Each SHALL shell out to its CLI in non-interactive mode with the appropriate auto-approve flags when `autoApprove` is true, execute scoped to `cwd`, and capture stdout/stderr as the tool output.

#### Scenario: Adapter runs in auto-approve mode

- **WHEN** the claude-code adapter's `run` is called with `autoApprove: true`
- **THEN** it invokes the CLI with non-interactive/auto-approve flags and does not block on permission prompts

#### Scenario: Adapter execution is scoped to cwd

- **WHEN** a tool adapter runs
- **THEN** the underlying process is launched with its working directory set to the provided `cwd` and never at the filesystem root

### Requirement: Mock tool adapter

The system SHALL ship a first-class `mock` tool adapter that returns canned plan/report/questions output and makes no network calls. The mock SHALL be configurable to emit questions for a given step so the questions/answers loop can be exercised offline.

#### Scenario: Mock tool produces deterministic output

- **WHEN** the mock tool's `run` is called for the planner role
- **THEN** it returns canned plan output and report text without any network access

#### Scenario: Mock tool can emit questions

- **WHEN** the mock tool is configured to raise questions for the planner step
- **THEN** its `run` resolves with a non-empty `questions` array

### Requirement: Health checks

Each tool SHALL implement `detect()` returning a health result indicating whether the tool's CLI is installed and runnable. The result SHALL distinguish at least "available" from "not found/unrunnable" and carry a human-readable message.

#### Scenario: Detect reports an installed tool

- **WHEN** `detect()` runs for a tool whose CLI is present and runnable
- **THEN** it resolves with an available status

#### Scenario: Detect reports a missing tool

- **WHEN** `detect()` runs for a tool whose CLI is absent
- **THEN** it resolves with a not-available status and a message explaining what was not found
