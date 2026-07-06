## ADDED Requirements

### Requirement: Multi-run execution

The runner SHALL execute the full pipeline `runs` times for a task. After each successful run it SHALL increment `completedRuns`; if `completedRuns < runs` it SHALL re-queue the task to `pending` for the next iteration, and only when `completedRuns >= runs` SHALL it move the task to `done`. The count strictly increases each run so execution always terminates.

#### Scenario: A task with runs=3 runs three times then finishes

- **WHEN** a task with `runs: 3` is processed to completion (mock tool)
- **THEN** the pipeline runs three times, `completedRuns` ends at 3, and the task ends in `done`

#### Scenario: Re-queued between runs, not finished early

- **WHEN** a task with `runs: 2` completes its first run
- **THEN** the task returns to `pending` with `completedRuns: 1` rather than moving to `done`

### Requirement: Critical-review framing on later iterations

On every run after the first (`completedRuns >= 1`), the runner SHALL inject a framing into the agent prompts stating that this is iteration X of N, that a previous AI already attempted the task and its work is present, and instructing the agent to critically review and adjust that work — treating it as another AI's solution and ensuring nothing is left behind. The first run SHALL NOT receive this framing.

#### Scenario: First run is unframed

- **WHEN** the first run of a task executes
- **THEN** the agent prompts do not contain the iteration/critical-review framing

#### Scenario: Later runs are framed

- **WHEN** the second run of a task with `runs: 3` executes
- **THEN** the agent prompts include an "Iteration 2 of 3" framing instructing the agent to review another AI's solution and leave nothing behind
