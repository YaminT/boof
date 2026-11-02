import { describe, expect, it } from "vitest";
import { goalFixture as g } from "./fixtures.js";
import { goalFormProblems, goalValues, sameGoalValues, slugify, toGoalInput } from "./goal-form.js";

describe("goal form", () => {
  it("round-trips a goal", () => {
    const goal = g({ dependsOn: ["x"], model: "opus" });
    const out = toGoalInput(goalValues(goal), goal.id);
    expect(out.spec).toEqual(goal.spec);
    expect(out.dependsOn).toEqual(["x"]);
    expect(out.model).toBe("opus");
    expect(out.id).toBe("g");
  });
  it("leaves out an empty model and coverage", () => {
    const out = toGoalInput(goalValues(g()), "g");
    expect("model" in out).toBe(false);
    expect("coverage" in out.spec).toBe(false);
  });
  it("slugifies titles and takes the slug for a new goal without an id", () => {
    expect(slugify("Fix: the SSE reconnect!")).toBe("fix-the-sse-reconnect");
    const v = { ...goalValues(null), title: "Fix: the SSE reconnect!" };
    expect(toGoalInput(v, null).id).toBe("fix-the-sse-reconnect");
  });
  it("reports the problems in the exact words", () => {
    const empty = goalValues(null);
    expect(goalFormProblems(empty, true, [])).toEqual([
      "Add a title.",
      "Describe the goal.",
      "Name the stack.",
      "Add at least one rule under Do.",
      "Fill in the test strategy, technology and run command.",
    ]);
    const ok = goalValues(g());
    expect(goalFormProblems(ok, false, [])).toEqual([]);
    expect(goalFormProblems({ ...ok, id: "Bad Id" }, true, [])).toEqual([
      "Use lowercase letters, digits and dashes for the id.",
    ]);
    expect(goalFormProblems({ ...ok, id: "taken" }, true, ["taken"])).toEqual([
      "Another goal already uses this id.",
    ]);
    expect(goalFormProblems({ ...ok, doRules: "  \n " }, false, [])).toEqual([
      "Add at least one rule under Do.",
    ]);
  });
  it("skips id problems for an existing goal", () => {
    expect(goalFormProblems({ ...goalValues(g()), id: "Bad Id" }, false, ["Bad Id"])).toEqual([]);
  });
  it("compares values", () => {
    expect(sameGoalValues(goalValues(g()), goalValues(g()))).toBe(true);
    expect(sameGoalValues(goalValues(g()), { ...goalValues(g()), title: "x" })).toBe(false);
  });
});
