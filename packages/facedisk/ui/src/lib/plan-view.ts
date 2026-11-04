import type { Goal, GoalStatus, PlanStatus } from "../api.js";
import { ApiError } from "../api.js";
import { errorMessage } from "./act.js";
import type { Tone } from "./status.js";

export const GOAL_STATUSES: readonly GoalStatus[] = ["plan", "develop", "review", "done"];

/** Goals by `order`, then id; a new array. */
export function sortGoals(goals: Goal[]): Goal[] {
  return [...goals].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function planProgress(goals: Goal[]): {
  total: number;
  done: number;
  byStatus: Record<GoalStatus, number>;
  percent: number | null;
} {
  const byStatus: Record<GoalStatus, number> = { plan: 0, develop: 0, review: 0, done: 0 };
  for (const g of goals) byStatus[g.status] += 1;
  const total = goals.length;
  const done = byStatus.done;
  return { total, done, byStatus, percent: total ? Math.round((100 * done) / total) : null };
}

export function goalStatusTone(s: GoalStatus): Tone {
  switch (s) {
    case "develop":
      return "running";
    case "review":
      return "attention";
    case "done":
      return "done";
    default:
      return "neutral";
  }
}

export function planStatusTone(s: PlanStatus): Tone {
  switch (s) {
    case "draft":
      return "attention";
    case "active":
      return "running";
    default:
      return "neutral";
  }
}

export function dependsOnTitles(
  goal: Goal,
  all: Goal[],
): { id: string; title: string; done: boolean; missing: boolean }[] {
  return goal.dependsOn.map((id) => {
    const dep = all.find((g) => g.id === id);
    return dep
      ? { id, title: dep.title, done: dep.status === "done", missing: false }
      : { id, title: id, done: false, missing: true };
  });
}

/** Human-readable lines for an API error; `invalid_plan` carries one line per issue. */
export function planErrorLines(err: unknown): string[] {
  if (err instanceof ApiError && err.code === "invalid_plan" && Array.isArray(err.details)) {
    return (err.details as { path?: string; message: string }[]).map((d) =>
      d.path ? `${d.path}: ${d.message}` : d.message,
    );
  }
  return [errorMessage(err)];
}
