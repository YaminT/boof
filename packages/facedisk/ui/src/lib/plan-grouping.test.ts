import { describe, expect, it } from "vitest";
import type { Plan, PlanSummary, TaskView } from "../api.js";
import {
  goalInfo,
  groupFromSearch,
  groupTasksByPlan,
  planChip,
  waitingFor,
  planCountsLabel,
  planRefOf,
  planTaskCounts,
  tasksByPlanHref,
} from "./plan-grouping.js";
import { readGroupBy, readGrouping, writeGroupBy } from "./epic-grouping.js";

const task = (id: string, status = "pending", ref?: { planId: string; goalId: string }) =>
  ({
    projectId: "p",
    frontmatter: { id, title: id, status, planRef: ref && { ...ref, revision: 1 } },
    body: {},
  }) as unknown as TaskView;
const summary = (id: string, o: Partial<PlanSummary> = {}) =>
  ({
    id,
    title: `Plan ${id}`,
    status: "active",
    created: `2026-01-0${id.length}`,
    ...o,
  }) as PlanSummary;
const detail = (id: string, goals: string[]) =>
  ({
    id,
    title: `Plan ${id}`,
    goals: goals.map((g) => ({ id: g, title: `Goal ${g}` })),
  }) as unknown as Plan;
const mem = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
};

describe("plan chips and counts", () => {
  it("reads the plan ref and builds the chip with the goal title, or ids while loading", () => {
    const t = task("t1", "pending", { planId: "a", goalId: "g2" });
    expect(planRefOf(task("x"))).toBeNull();
    expect(planChip("p", task("x"), new Map(), new Map())).toBeNull();
    const chip = planChip(
      "p",
      t,
      new Map([["a", summary("a")]]),
      new Map([["a", detail("a", ["g1", "g2"])]]),
    );
    expect(chip?.label).toBe("Plan: Plan a › Goal g2");
    expect(chip?.href).toBe("p/p/plans/a/g2");
    expect(planChip("p", t, new Map(), new Map())?.label).toBe("Plan: a › g2");
  });

  it("counts done, running and waiting tasks of one plan, not archived or other plans", () => {
    const r = (g: string) => ({ planId: "a", goalId: g });
    const tasks = [
      task("1", "done", r("1")),
      task("2", "running", r("2")),
      task("3", "pending", r("3")),
      task("4", "draft", r("4")),
      task("5", "failed", r("5")),
      task("6", "archived", r("6")),
      task("7", "pending", { planId: "b", goalId: "1" }),
      task("8"),
    ];
    const c = planTaskCounts(tasks, "a");
    expect(c).toEqual({ total: 5, done: 1, running: 1, waiting: 2 });
    expect(planCountsLabel(c)).toBe("5 tasks: 1 done, 1 running, 2 waiting");
    expect(planCountsLabel(planTaskCounts(tasks, "zz"))).toBe("No tasks yet");
    expect(planCountsLabel({ total: 1, done: 0, running: 0, waiting: 0 })).toBe("1 task");
  });

  it("gives a goal's place in its plan", () => {
    expect(goalInfo(detail("a", ["g1", "g2", "g3"]), "g2")).toEqual({
      title: "Goal g2",
      n: 2,
      m: 3,
    });
    expect(goalInfo(detail("a", ["g1"]), "nope")).toBeNull();
    expect(goalInfo(undefined, "g1")).toBeNull();
  });

  it("links to Tasks grouped by plan and reads the group from a query", () => {
    expect(tasksByPlanHref("p")).toBe("p/p/tasks?group=plan");
    expect(groupFromSearch("?group=plan")).toBe("plan");
    expect(groupFromSearch("?group=x")).toBeNull();
    expect(groupFromSearch("")).toBeNull();
  });
});

describe("groupTasksByPlan", () => {
  const plans = [summary("bb", { created: "2026-02-01" }), summary("a", { created: "2026-01-01" })];
  it("orders plans oldest first, tasks in goal order, and puts 'Not in a plan' last", () => {
    const tasks = [
      task("loose"),
      task("b1", "pending", { planId: "bb", goalId: "g1" }),
      task("a2", "done", { planId: "a", goalId: "g2" }),
      task("a1", "pending", { planId: "a", goalId: "g1" }),
      task("gone", "pending", { planId: "deleted", goalId: "g1" }),
    ];
    const out = groupTasksByPlan(tasks, plans, tasks, new Map([["a", detail("a", ["g1", "g2"])]]));
    expect(out.map((g) => g.label)).toEqual(["Plan a", "Plan bb", "Not in a plan"]);
    expect(out[0]!.tasks.map((t) => t.frontmatter.id)).toEqual(["a1", "a2"]);
    expect(out[0]!.progress).toEqual({ done: 1, total: 2 });
    expect(out[2]!.tasks.map((t) => t.frontmatter.id)).toEqual(["loose", "gone"]);
    expect(out[2]!.key).toBe("none");
  });

  it("keeps the order of tasks when the plan is not loaded, and skips plans without tasks", () => {
    const tasks = [
      task("a2", "pending", { planId: "a", goalId: "g2" }),
      task("a1", "pending", { planId: "a", goalId: "g1" }),
    ];
    const out = groupTasksByPlan(tasks, plans);
    expect(out).toHaveLength(1);
    expect(out[0]!.tasks.map((t) => t.frontmatter.id)).toEqual(["a2", "a1"]);
  });
});

describe("group-by preference", () => {
  it("round-trips none, epic and plan and still reads the old checkbox value", () => {
    const s = mem();
    expect(readGroupBy(s, "p")).toBe("none");
    writeGroupBy(s, "p", "plan");
    expect(readGroupBy(s, "p")).toBe("plan");
    expect(readGrouping(s, "p")).toBe(false);
    writeGroupBy(s, "p", "epic");
    expect(readGroupBy(s, "p")).toBe("epic");
    expect(readGrouping(s, "p")).toBe(true);
    writeGroupBy(s, "p", "none");
    expect(readGroupBy(s, "p")).toBe("none");
    s.setItem("boof.groupByEpic.old", "1");
    expect(readGroupBy(s, "old")).toBe("epic");
  });
});

describe("waitingFor", () => {
  const plan = {
    goals: [
      { id: "a", title: "Scaffold", dependsOn: [], status: "done" },
      { id: "b", title: "Models", dependsOn: [], status: "develop" },
      { id: "c", title: "List", dependsOn: ["a", "b"], status: "develop" },
    ],
  } as unknown as Plan;
  const task = (labels: string[]) =>
    ({ frontmatter: { labels, planRef: { planId: "p", goalId: "c", revision: 1 } } }) as never;

  it("names the unfinished dependencies of a blocked task", () => {
    expect(waitingFor(task(["blocked"]), plan)).toEqual(["Models"]);
  });
  it("is null for an unblocked task or an unloaded plan", () => {
    expect(waitingFor(task([]), plan)).toBeNull();
    expect(waitingFor(task(["blocked"]), undefined)).toBeNull();
  });
});
