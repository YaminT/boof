## Context

The base system runs a task through planner → developer → reviewer once, in a per-task git worktree that is deleted on completion. This change lets a user request N passes, where passes after the first critically review and refine the prior pass's work. For that framing to be meaningful, a later pass must be able to *see* the earlier pass's output — which the single-use, deleted-on-completion worktree did not allow.

## Goals / Non-Goals

**Goals:**
- A `runs` count per task (default 1) and a `completedRuns` progress counter.
- Re-run the full pipeline `runs` times, injecting a critical-review framing on passes after the first.
- Make iterations cumulative by reusing the worktree across runs.

**Non-Goals:**
- Merging the worktree branch back to the base (unchanged from the base system; work still lives in the per-task branch).
- Per-iteration report history (the task body mirrors the latest run's reports; the worktree holds the accumulated code).
- Stopping early on a "good enough" heuristic — the count is exact.

## Decisions

### D1. Two fields: `runs` (intent) and `completedRuns` (progress)
`runs` is user input; `completedRuns` is runner-owned. `currentIteration = completedRuns + 1`. Keeping them separate makes progress observable in the UI and survives re-queue. Both have schema defaults so existing files stay valid. *Alternative:* a single "remaining" counter — rejected; it loses the "X of N" framing the prompt needs.

### D2. Re-queue via `running → pending`
After a successful non-final run the engine increments `completedRuns` and transitions `running → pending`; the loop re-selects it naturally. Only the final run goes to `done`. This reuses the existing selection/scheduling with one new legal transition, rather than a bespoke loop inside one task's run. Equal-priority fairness falls out for free (the re-queued task sorts behind same-priority peers by `updated`).

### D3. Framing injected in `buildPrompt`, gated on iteration > 1
A single `iterationFraming(task)` helper returns the critical-review text for `completedRuns >= 1`, prepended to every role's prompt. Centralizing it in `buildPrompt` means planner, refinement, developer, and reviewer all receive the same context with no per-call wiring.

### D4. Worktree reuse with a meta sidecar
`ensureWorktree` reuses an existing per-task worktree (validated by a `.boof-runner-worktrees/.meta/<id>.json` sidecar + a branch check) or creates a fresh one. Cleanup happens only on final `done`/`failed`; park and intermediate-done retain the worktree. This makes runs cumulative while keeping the isolation and base-diff guarantees intact. *Alternative:* re-create from base each run — rejected; later passes would have nothing to review.

## Risks / Trade-offs

- **Leftover worktrees if a task never finishes** → cleanup on final-done/failed plus startup `git worktree prune` bound the leakage; the sidecar is removed on cleanup.
- **Failure mid-multi-run loses accumulated work on retry** → accepted: failure is exceptional and retry restarts cleanly; the common path (questions/park) retains the worktree.
- **Latest-run reports overwrite earlier ones in the task body** → accepted for this iteration; the durable code lives in the reused worktree, and per-iteration report history is a non-goal.
