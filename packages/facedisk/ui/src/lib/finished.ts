import type { TopbarState } from "./topbar.js";

/** How long the "Finished" tint stays when nobody dismisses it. */
export const FINISHED_TTL_MS = 10 * 60_000;

/** The client's small memory of the last completion. */
export interface FinishedMemory {
  /** Task ids seen running since the queue last emptied. */
  seen: readonly string[];
  /** Done tasks across all projects when the work started (the overview's counts). */
  baseDone: number;
  /** Set when the queue emptied after work ran. */
  finished: { count: number; at: number } | null;
}

export const EMPTY_FINISHED: FinishedMemory = { seen: [], baseDone: 0, finished: null };

export interface FinishedInput {
  kind: TopbarState["kind"];
  /** `pid/taskId` of every running task. */
  running: readonly string[];
  /** Tasks waiting for the runner. */
  queued: number;
  now: number;
  /**
   * Tasks in the done folder across ALL projects, from the runner overview (the server's counts,
   * not the selected project's task list). The finish counts how many were added since the work began.
   */
  doneTotal: number;
}

/**
 * Step the memory on a new runner state. Work starting clears a finish; the queue emptying
 * (nothing running, nothing queued, the runner idle) after work ran sets one. Other states
 * (paused, blocked, waiting) keep what they have: a pause is not a finish.
 */
export function stepFinished(mem: FinishedMemory, input: FinishedInput): FinishedMemory {
  if (input.running.length > 0) {
    const seen = [...new Set([...mem.seen, ...input.running])];
    if (seen.length === mem.seen.length && !mem.finished) return mem;
    return {
      seen,
      baseDone: mem.seen.length === 0 ? input.doneTotal : mem.baseDone,
      finished: null,
    };
  }
  if (input.kind === "idle" && input.queued === 0 && mem.seen.length > 0) {
    const count = Math.max(0, input.doneTotal - mem.baseDone);
    return { seen: [], baseDone: 0, finished: count > 0 ? { count, at: input.now } : null };
  }
  if (mem.finished && input.now - mem.finished.at >= FINISHED_TTL_MS) {
    return { ...mem, finished: null };
  }
  return mem;
}

/** The state with the "Finished" look when a finish is remembered and the runner is idle. */
export function withFinished(state: TopbarState, mem: FinishedMemory, now: number): TopbarState {
  const f = mem.finished;
  if (!f || state.kind !== "idle" || now - f.at >= FINISHED_TTL_MS) return state;
  return { ...state, tone: "finished", text: `Finished · ${f.count} done` };
}
