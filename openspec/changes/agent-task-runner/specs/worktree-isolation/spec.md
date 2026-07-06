## ADDED Requirements

### Requirement: Working directory must be a git repository

The system SHALL require the configured `workingDirectory` to be a git repository for worktree-isolated runs. When it is not a git repository, the system SHALL warn loudly and SHALL NOT proceed with a worktree-isolated run.

#### Scenario: Non-git working directory is rejected

- **WHEN** the runner attempts to start a task and `workingDirectory` is not a git repository
- **THEN** the system SHALL surface a clear warning and the task SHALL NOT run agents against that directory

### Requirement: Per-task git worktree

When a task starts, the system SHALL create a dedicated git worktree (or branch) rooted at `workingDirectory` for that task. The developer agent's changes SHALL be made inside this worktree so they are isolated from the base and from other tasks.

#### Scenario: Worktree is created on task start

- **WHEN** the runner begins a task against a git `workingDirectory`
- **THEN** a per-task worktree is created and the developer step runs with `cwd` set to that worktree

#### Scenario: Reviewer diffs against base

- **WHEN** the reviewer step runs after the developer step
- **THEN** it can obtain the diff of the worktree against the base revision for review

### Requirement: Worktree cleanup

The system SHALL clean up the per-task worktree when the run completes (success or failure). Cleanup SHALL remove the worktree without affecting the base repository's other branches/worktrees.

#### Scenario: Worktree removed on completion

- **WHEN** a task run finishes and reaches `done` or `failed`
- **THEN** its per-task worktree is removed and no longer present under the working directory

### Requirement: Scoped agent execution

All tool execution SHALL be scoped to the task's worktree `cwd`. The system SHALL never launch an agent at the filesystem root or outside the configured working area.

#### Scenario: Agents never run at root

- **WHEN** any pipeline step invokes a tool
- **THEN** the tool's `cwd` is the task worktree (or the working directory), never `/`
