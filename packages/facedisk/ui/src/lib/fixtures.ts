import type { Goal } from "../api.js";

/** A goal for tests; every field overridable. */
export function goalFixture(over: Partial<Goal> = {}): Goal {
  return {
    id: "g",
    title: "G",
    order: 1,
    dependsOn: [],
    status: "plan",
    revision: 1,
    spec: {
      goal: "Do it",
      stack: "TS",
      rules: { do: ["a", "b"], dont: ["c"] },
      tests: { strategy: "unit", technology: "vitest", run: "npx vitest run" },
    },
    history: [],
    tasks: [],
    ...over,
  } as Goal;
}
