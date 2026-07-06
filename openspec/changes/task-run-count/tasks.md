## 1. Data model

- [x] 1.1 Add `runs` (int ≥ 1, default 1) and `completedRuns` (int ≥ 0, default 0) to the task frontmatter schema
- [x] 1.2 Add the `running → pending` re-queue transition to the state machine

## 2. Runner

- [x] 2.1 Reuse the per-task worktree across iterations via `ensureWorktree` + meta sidecar; clean up only on final-done/failure
- [x] 2.2 Inject the critical-review framing into prompts on iterations after the first (`iterationFraming`)
- [x] 2.3 Re-queue to `pending` and increment `completedRuns` after each non-final run; finish on the final run

## 3. Web (API + UI)

- [x] 3.1 Accept and clamp `runs` on task create/update in the service
- [x] 3.2 Add the `Runs` input to the editor and include `runs` in create/update calls
- [x] 3.3 Show run progress (`completedRuns/runs`) in the task list for multi-run tasks

## 4. Tests

- [x] 4.1 task-file round-trip preserves the new fields; schema defaults apply
- [x] 4.2 Worktree reuse preserves prior-iteration work across `ensureWorktree` calls
- [x] 4.3 Engine: runs=3 executes three times and ends `done` with `completedRuns: 3`
- [x] 4.4 Engine: runs=2 re-queues to `pending` after the first run
- [x] 4.5 Framing absent on run 1, present (with "another AI's solution") on runs 2+
