import { describe, expect, it } from "vitest";
import { applyGoalInputs, mergeOrderOf } from "./plan-ops.js";
import { testGoal } from "./plan-fixtures.js";
import { exportPlanXml } from "./plan-xml.js";

const AT = "2026-10-01T00:00:00.000Z";

describe("applyGoalInputs: a changed spec reopens a done goal", () => {
  const done = testGoal("a", 1, [], { status: "done", path: "a" });
  const change = (goal: string, status?: "done") => ({
    id: "a",
    title: "A",
    dependsOn: [],
    ...(status ? { status } : {}),
    spec: { ...done.spec, goal },
  });

  it("sets develop with a history entry at once", () => {
    const [g] = applyGoalInputs([done], [change("New spec")], { replace: true, at: AT });
    expect(g!.revision).toBe(2);
    expect(g!.status).toBe("develop");
    expect(g!.history.at(-1)).toEqual({
      revision: 2,
      status: "develop",
      description: "spec changed to revision 2",
      at: AT,
    });
  });

  it("leaves a done goal alone when nothing but the title changed", () => {
    const [g] = applyGoalInputs([done], [{ ...change(done.spec.goal), title: "Renamed" }], {
      replace: false,
    });
    expect(g!.status).toBe("done");
    expect(g!.revision).toBe(1);
  });

  it("does not touch goals that are not done", () => {
    const open = testGoal("a", 1, [], { status: "review" });
    const [g] = applyGoalInputs([open], [change("New spec")], { replace: false });
    expect(g!.status).toBe("review");
    expect(g!.history).toEqual([]);
  });
});

describe("runtime fields stay out of the XML export", () => {
  it("ignores goal.tasks, taskId and history task ids", () => {
    const plain = testGoal("a", 1, [], { path: "a", history: [] });
    const busy = testGoal("a", 1, [], {
      path: "a",
      taskId: "boof-a",
      tasks: [{ taskId: "boof-a", revision: 1, status: "running", branch: "boof-runner/boof-a" }],
      history: [{ revision: 1, status: "done", description: "x", at: AT, taskId: "boof-a" }],
    });
    const withHistory = testGoal("a", 1, [], {
      path: "a",
      history: [{ revision: 1, status: "done", description: "x", at: AT }],
    });
    expect(exportPlanXml({ goals: [busy] })).toEqual(exportPlanXml({ goals: [withHistory] }));
    expect(Object.keys(exportPlanXml({ goals: [plain] }))).toContain("a/goal.boof.xml");
  });
});

describe("mergeOrderOf", () => {
  const ref = (id: string) => ({
    taskId: `boof-${id}`,
    revision: 1,
    status: "done" as const,
    branch: `boof-runner/boof-${id}`,
  });
  it("lists the last task branch of each goal in topological order and skips goals without one", () => {
    const a = testGoal("a", 3, [], { tasks: [ref("a")] });
    const b = testGoal("b", 1, ["a"], {
      tasks: [ref("b"), { ...ref("b"), taskId: "update-b", branch: "boof-runner/update-b" }],
    });
    const c = testGoal("c", 2, ["a"]);
    expect(mergeOrderOf({ goals: [b, c, a] })).toEqual([
      { goalId: "a", taskId: "boof-a", branch: "boof-runner/boof-a" },
      { goalId: "b", taskId: "update-b", branch: "boof-runner/update-b" },
    ]);
  });
});
