import { describe, expect, it } from "vitest";
import { ApiError } from "../api.js";
import { goalFixture as g } from "./fixtures.js";
import {
  dependsOnTitles,
  goalStatusTone,
  planErrorLines,
  planProgress,
  planStatusTone,
  sortGoals,
} from "./plan-view.js";

describe("plan view", () => {
  it("sorts by order then id, into a new array", () => {
    const input = [g({ id: "c", order: 3 }), g({ id: "a", order: 1 }), g({ id: "b", order: 1 })];
    const out = sortGoals(input);
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(out).not.toBe(input);
    expect(input[0].id).toBe("c");
  });
  it("counts progress", () => {
    const none = planProgress([]);
    expect(none).toMatchObject({ total: 0, done: 0, percent: null });
    expect(Object.values(none.byStatus)).toEqual([0, 0, 0, 0]);
    const p = planProgress([
      g({ status: "done" }),
      g({ id: "b" }),
      g({ id: "c", status: "review" }),
    ]);
    expect(p.percent).toBe(33);
    expect(p.byStatus.review).toBe(1);
  });
  it("names dependencies, flagging missing ones", () => {
    const all = [g({ id: "x", title: "X", status: "done" })];
    expect(dependsOnTitles(g({ dependsOn: ["x", "gone"] }), all)).toEqual([
      { id: "x", title: "X", done: true, missing: false },
      { id: "gone", title: "gone", done: false, missing: true },
    ]);
  });
  it("turns invalid_plan details into lines and other errors into their message", () => {
    const err = new ApiError("bad", 400, "invalid_plan", [
      { path: "goals.0.dependsOn", message: "unknown goal z" },
      { message: "cycle" },
    ]);
    expect(planErrorLines(err)).toEqual(["goals.0.dependsOn: unknown goal z", "cycle"]);
    expect(planErrorLines(new Error("boom"))).toEqual(["boom"]);
  });
  it("maps statuses to tones", () => {
    expect(goalStatusTone("plan")).toBe("neutral");
    expect(goalStatusTone("develop")).toBe("running");
    expect(goalStatusTone("review")).toBe("attention");
    expect(goalStatusTone("done")).toBe("done");
    expect(planStatusTone("draft")).toBe("attention");
    expect(planStatusTone("active")).toBe("running");
    expect(planStatusTone("archived")).toBe("neutral");
  });
});
