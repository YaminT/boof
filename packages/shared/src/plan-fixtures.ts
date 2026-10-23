import type { Goal } from "./plan-schema.js";

/** A valid goal for tests (also used by the runner, web and bin tests). */
export function testGoal(
  id: string,
  order: number,
  dependsOn: string[] = [],
  over: Partial<Goal> = {},
): Goal {
  return {
    id,
    title: id.toUpperCase(),
    order,
    dependsOn,
    status: "plan",
    spec: {
      goal: `Build ${id}`,
      stack: "TypeScript",
      rules: { do: ["Write a failing test first."], dont: [] },
      tests: { strategy: "TDD", technology: "vitest", run: "npm test" },
    },
    revision: 1,
    taskId: null,
    history: [],
    ...over,
  };
}
