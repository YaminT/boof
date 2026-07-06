## MODIFIED Requirements

### Requirement: Worktree cleanup

The system SHALL reuse a task's git worktree across the iterations of a multi-run task so each run builds on the prior run's work. The system SHALL clean up the per-task worktree only when the task reaches its final `done` run or `failed`. Cleanup SHALL remove the worktree (and its bookkeeping) without affecting the base repository's other branches/worktrees.

#### Scenario: Worktree reused across iterations

- **WHEN** a multi-run task starts its second iteration
- **THEN** the same per-task worktree is reused and the previous iteration's changes are present in it

#### Scenario: Worktree removed on final completion

- **WHEN** a task finishes its final run (reaching `done`) or fails
- **THEN** its per-task worktree is removed and no longer present under the working directory

#### Scenario: Worktree retained between runs

- **WHEN** a multi-run task completes a non-final run and is re-queued
- **THEN** its worktree is retained for the next run
