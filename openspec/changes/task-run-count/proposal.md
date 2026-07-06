## Why

Running an agent pipeline once often leaves gaps: missed edge cases, half-finished work, no second look. Users want to ask the runner to take multiple passes at a task, where each pass after the first critically reviews and refines the previous pass's output — as if auditing another AI's solution — until nothing is left behind.

## What Changes

- Add a per-task **`runs`** count (integer ≥ 1, default 1) authored in the editor, plus a **`completedRuns`** counter tracking progress.
- The runner executes the full pipeline **`runs` times** for a task: after each successful run, if more runs remain it re-queues the task (`running → pending`) for the next iteration; on the final run it finishes (`running → done`).
- On every iteration **after the first**, inject a critical-review framing into the agent prompts: state that this is iteration X of N, that a previous AI already attempted the task and its work is present, and instruct the agent to review/adjust it rigorously, treat it as another AI's solution, and ensure nothing is left behind.
- Make per-task **git worktrees persist across iterations** (reused, not recreated) so each run builds on the prior run's work; the worktree is cleaned up only on the final run or on failure.
- Surface run progress in the UI (`completedRuns/runs`) and add a **Runs** input to the editor.

## Capabilities

### New Capabilities

<!-- None — extends existing capabilities. -->

### Modified Capabilities

- `task-file`: Frontmatter gains `runs` and `completedRuns` fields with defaults.
- `task-lifecycle`: Adds the `running → pending` transition to re-queue a task for its next iteration.
- `runner-pipeline`: Runs the pipeline `runs` times, increments `completedRuns`, and injects the critical-review framing on iterations after the first.
- `worktree-isolation`: Per-task worktrees are reused across iterations and cleaned up only on the final run/failure.
- `web-ui`: The editor exposes a `Runs` input and the task list shows run progress.

## Impact

- Schema change to task frontmatter (back-compatible: defaults apply to existing files).
- Runner selection now re-picks re-queued tasks; multi-run tasks complete after N pipeline passes.
- Worktree lifecycle extended (sidecar meta records the per-task worktree for reuse).
- No new dependencies.
