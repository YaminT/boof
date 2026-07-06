import type { Status } from "./schema.js";

/**
 * Legal status transitions (task-lifecycle spec). Any transition not listed
 * here is rejected. `skip` is orthogonal and never appears as a transition.
 */
const TRANSITIONS: Record<Status, Status[]> = {
  // Any non-running task can be archived; running tasks must finish first.
  draft: ["pending", "archived"],
  pending: ["running", "archived"],
  // running → pending re-queues the task for its next iteration (multi-run).
  running: ["pending", "action", "done", "failed"],
  action: ["pending", "archived"],
  done: ["archived"],
  failed: ["pending", "archived"],
  // Unarchive back into the queue.
  archived: ["pending"],
};

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: Status,
    public readonly to: Status,
  ) {
    super(`Invalid status transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** Assert a transition is legal, throwing InvalidTransitionError otherwise. */
export function assertTransition(from: Status, to: Status): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function allowedTransitions(from: Status): Status[] {
  return [...TRANSITIONS[from]];
}
