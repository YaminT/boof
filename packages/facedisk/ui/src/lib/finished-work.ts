import type { Goal } from "../api.js";
import { sortGoals } from "./plan-view.js";

export interface FinishedWork {
  /** The branch that holds the finished work (the last goal's branch; tasks are stacked). */
  branch: string;
  /** Every task branch of the plan, in goal order. */
  branches: string[];
  /** A command that brings the work into the branch you are on. */
  mergeCommand: string;
}

/**
 * Where a finished plan's work lives. The runner commits each task on its own `boof-runner/<id>`
 * branch, stacked on the one before, and never touches the main branch. Null until every goal is
 * done and at least one has a task branch.
 */
export function finishedWork(goals: readonly Goal[]): FinishedWork | null {
  if (goals.length === 0 || goals.some((g) => g.status !== "done")) return null;
  const branches = sortGoals([...goals])
    .map((g) => g.tasks.at(-1)?.branch)
    .filter((b): b is string => !!b);
  const branch = branches.at(-1);
  if (!branch) return null;
  return { branch, branches, mergeCommand: mergeCommandFor(branch) };
}

/** The command that brings the work on `branch` into the branch you are on. */
export const mergeCommandFor = (branch: string): string => `git merge ${branch}`;
