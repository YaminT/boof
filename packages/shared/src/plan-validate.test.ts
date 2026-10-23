import { describe, expect, it } from "vitest";
import { testGoal as goal } from "./plan-fixtures.js";
import { PlanSchema, type Goal, type Plan } from "./plan-schema.js";
import {
  isValidTopologicalOrder,
  normalizeOrder,
  planIssues,
  PlanValidationError,
  validatePlan,
} from "./plan-validate.js";

const NOW = "2026-06-04T10:00:00.000Z";

function plan(goals: Goal[]): Plan {
  return PlanSchema.parse({
    id: "p",
    title: "P",
    source: { kind: "api" },
    goals,
    created: NOW,
    updated: NOW,
  });
}

describe("validatePlan", () => {
  it("accepts a valid DAG and sorts goals by order", () => {
    const out = validatePlan(plan([goal("b", 2, ["a"]), goal("a", 1)]));
    expect(out.goals.map((g) => g.id)).toEqual(["a", "b"]);
  });

  it("rejects duplicate goal ids", () => {
    expect(() => validatePlan(plan([goal("a", 1), goal("a", 2)]))).toThrow(PlanValidationError);
    const issues = planIssues([goal("a", 1), goal("a", 2)]);
    expect(issues[0]!.message).toContain('duplicate goal id "a"');
  });

  it("rejects dependencies on unknown goals and self-dependencies", () => {
    expect(planIssues([goal("a", 1, ["ghost"])])[0]!.message).toContain('unknown goal "ghost"');
    expect(planIssues([goal("a", 1, ["a"])])[0]!.message).toContain("depends on itself");
  });

  it("rejects cycles", () => {
    const issues = planIssues([goal("a", 1, ["b"]), goal("b", 2, ["a"])]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("cycle");
    expect(() => validatePlan(plan([goal("a", 1, ["b"]), goal("b", 2, ["a"])]))).toThrow(/cycle/);
  });

  it("rejects an order that contradicts the dependencies unless it is normalised", () => {
    const bad = plan([goal("a", 2), goal("b", 1, ["a"])]);
    expect(() => validatePlan(bad)).toThrow(/must come after/);
    const fixed = validatePlan(bad, { normalizeOrder: true });
    expect(fixed.goals.map((g) => [g.id, g.order])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("normalises to 1..n keeping the given order where dependencies allow", () => {
    const out = normalizeOrder([goal("c", 30), goal("a", 10), goal("b", 20, ["c"])]);
    expect(out.map((g) => [g.id, g.order])).toEqual([
      ["a", 1],
      ["c", 2],
      ["b", 3],
    ]);
  });

  it("checks a proposed order is topological and complete", () => {
    const goals = [goal("a", 1), goal("b", 2, ["a"]), goal("c", 3)];
    expect(isValidTopologicalOrder(goals, ["c", "a", "b"])).toBe(true);
    expect(isValidTopologicalOrder(goals, ["b", "a", "c"])).toBe(false);
    expect(isValidTopologicalOrder(goals, ["a", "b"])).toBe(false);
    expect(isValidTopologicalOrder(goals, ["a", "a", "b"])).toBe(false);
  });
});

describe("goal path", () => {
  it("must stay inside the repository", () => {
    const base = goal("a", 1);
    for (const path of ["../x", "/etc", "a/../../b", "C:\\x"]) {
      expect(() => plan([{ ...base, path }])).toThrow();
    }
    expect(plan([{ ...base, path: "packages/a" }]).goals[0]!.path).toBe("packages/a");
  });
});
