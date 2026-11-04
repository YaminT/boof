/**
 * Adapters between the stored {@link Plan} and boof-planner's XML files (`plan.boof.xml`,
 * `goal.boof.xml`), built on the reader/writer in boof-goal.ts. Import then export reproduces
 * the XML of untouched goals byte for byte.
 */
import {
  GOAL_FILE,
  PLAN_FILE,
  serializeGoal,
  serializePlan,
  type BoofGoal,
  type BoofPlan,
  type BoofVersion,
} from "./boof-goal.js";
import type { Goal, GoalHistoryEntry, GoalSpec } from "./plan-schema.js";
import { nowIso } from "./runtime.js";

/** Unit directory of a goal, relative to the repo root; goals without a path use their id. */
export function goalDir(goal: Pick<Goal, "id" | "path">): string {
  const dir = (goal.path ?? goal.id).replace(/\\/g, "/").replace(/\/+$/, "");
  return dir === "" ? "." : dir;
}

/** Path of the goal's goal.boof.xml relative to the repo root. */
export function goalFilePath(goal: Pick<Goal, "id" | "path">): string {
  const dir = goalDir(goal);
  return dir === "." ? GOAL_FILE : `${dir}/${GOAL_FILE}`;
}

/** The spec of a parsed goal file. */
export function specFromBoofGoal(goal: BoofGoal): GoalSpec {
  return {
    goal: goal.overal.goal,
    stack: goal.overal.stack,
    rules: { do: [...goal.overal.rules.do], dont: [...goal.overal.rules.dont] },
    tests: { ...goal.progress.tests },
  };
}

/**
 * History entries of a parsed goal file (one per <version>, ascending). They are recorded at
 * revision 1 and keep their version number; `at` is the import time (XML has no timestamps).
 */
export function historyFromBoofGoal(goal: BoofGoal, at: string = nowIso()): GoalHistoryEntry[] {
  return [...goal.progress.versions]
    .sort((a, b) => a.number - b.number)
    .map((v) => ({
      revision: 1,
      status: v.status,
      description: v.description,
      at,
      number: v.number,
    }));
}

/** Versions to write for a goal: stored numbers are kept, new entries continue the sequence. */
function versionsOf(goal: Goal): BoofVersion[] {
  if (goal.history.length === 0) {
    return [{ number: 1, status: goal.status, description: "exported from boof-runner" }];
  }
  let max = 0;
  return goal.history.map((h) => {
    const number = h.number !== undefined && h.number > max ? h.number : max + 1;
    max = number;
    return { number, status: h.status, description: h.description };
  });
}

/** The goal as a BoofGoal (goal.boof.xml content). */
export function goalToBoofGoal(goal: Goal): BoofGoal {
  return {
    ...(goal.model ? { model: goal.model } : {}),
    overal: {
      goal: goal.spec.goal,
      stack: goal.spec.stack,
      rules: { do: [...goal.spec.rules.do], dont: [...goal.spec.rules.dont] },
    },
    progress: {
      versions: versionsOf(goal),
      tests: {
        strategy: goal.spec.tests.strategy,
        technology: goal.spec.tests.technology,
        run: goal.spec.tests.run,
        ...(goal.spec.tests.coverage ? { coverage: goal.spec.tests.coverage } : {}),
      },
    },
  };
}

/** The plan as a BoofPlan (plan.boof.xml content). */
export function planToBoofPlan(plan: { goals: Goal[] }): BoofPlan {
  return {
    goals: plan.goals.map((g) => ({
      id: g.id,
      path: goalDir(g),
      order: g.order,
      status: g.status,
      dependsOn: [...g.dependsOn],
    })),
  };
}

/**
 * Every XML file of a plan, keyed by path relative to the repo root: `plan.boof.xml` plus one
 * `<path>/goal.boof.xml` per goal. Nothing is written; the caller decides where they go.
 */
export function exportPlanXml(plan: { goals: Goal[] }): Record<string, string> {
  const files: Record<string, string> = {};
  if (plan.goals.length > 0) files[PLAN_FILE] = serializePlan(planToBoofPlan(plan));
  for (const goal of plan.goals) files[goalFilePath(goal)] = serializeGoal(goalToBoofGoal(goal));
  return files;
}
