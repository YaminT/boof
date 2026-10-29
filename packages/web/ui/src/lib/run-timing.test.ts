import { describe, expect, it } from "vitest";
import type { TaskView } from "../api";
import { formatDuration, runLabel, startedAtMs, stepStrip } from "./run-timing";

const T0 = Date.parse("2026-10-29T10:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function task(
  fm: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
  status = "running",
): TaskView {
  return {
    frontmatter: { id: "t1", title: "T", status, runs: 1, completedRuns: 0, ...fm },
    ...extra,
  } as unknown as TaskView;
}
const steps = (...s: [string, number][]) => s.map(([label, sec]) => ({ label, at: at(sec) }));
const byRole = (segs: ReturnType<typeof stepStrip>) =>
  Object.fromEntries(segs.map((s) => [s.role, s]));

describe("startedAtMs", () => {
  it("is null for a missing or invalid start", () => {
    expect(startedAtMs(task())).toBeNull();
    expect(startedAtMs(task({ startedAt: "garbage" }))).toBeNull();
    expect(startedAtMs(task({ startedAt: at(0) }))).toBe(T0);
  });
});

describe("stepStrip", () => {
  it("collapses planner and refinement, times done and current roles", () => {
    const t = task({
      steps: steps(["Planner", 0], ["Planner (refinement)", 20], ["Developer", 50]),
    });
    const r = byRole(stepStrip(t, T0 + 290_000));
    expect(r.planner).toMatchObject({ state: "done", seconds: 50 });
    expect(r.developer).toMatchObject({ state: "current", seconds: 240 });
    expect(r.observer).toMatchObject({ state: "upcoming", seconds: null });
    expect(r.reviewer).toMatchObject({ state: "upcoming", seconds: null });
  });

  it("always returns four segments in role order", () => {
    expect(stepStrip(task(), T0).map((s) => s.role)).toEqual([
      "planner",
      "developer",
      "observer",
      "reviewer",
    ]);
  });

  it("takes the round from the labels and keeps developer one segment", () => {
    const t = task({
      steps: steps(
        ["Planner", 0],
        ["Developer", 10],
        ["Reviewer (round 1)", 20],
        ["Developer (fix round 1, reviewer)", 30],
        ["Reviewer (round 2)", 40],
      ),
    });
    const segs = stepStrip(t, T0 + 50_000);
    expect(segs).toHaveLength(4);
    const r = byRole(segs);
    expect(r.reviewer).toMatchObject({ round: 2, state: "current" });
    expect(r.developer.state).toBe("done");
  });

  it("maps verdicts", () => {
    const v = (reviewer?: string, observer?: string) =>
      byRole(stepStrip(task({}, { finalVerdict: { reviewer, observer } }), T0));
    expect(v("APPROVE").reviewer.verdict).toBe("approve");
    expect(v("CHANGES_REQUESTED").reviewer.verdict).toBe("reject");
    expect(v("REJECT").reviewer.verdict).toBe("reject");
    expect(v("INVALID").reviewer.verdict).toBeNull();
    expect(v().reviewer.verdict).toBeNull();
    expect(v(undefined, "APPROVE").observer.verdict).toBe("approve");
    expect(v(undefined, "REJECT").observer.verdict).toBe("reject");
    expect(v(undefined, "INVALID").observer.verdict).toBeNull();
  });

  it("falls back to the highest review round of the current iteration without steps", () => {
    const reviews = [
      { role: "reviewer", round: 1, iteration: 1, verdict: "CHANGES_REQUESTED", summary: "" },
      { role: "reviewer", round: 2, iteration: 1, verdict: "APPROVE", summary: "" },
      { role: "observer", round: 3, iteration: 0, verdict: "APPROVE", summary: "" },
    ];
    const r = byRole(stepStrip(task({ completedRuns: 0 }, { reviews }), T0));
    expect(r.reviewer.round).toBe(2);
  });

  it("uses the log headers for a legacy task", () => {
    const r = byRole(stepStrip(task(), T0, ["Planner", "Developer"]));
    expect(r.planner).toMatchObject({ state: "done", seconds: null });
    expect(r.developer).toMatchObject({ state: "current", seconds: null });
    expect(r.observer).toMatchObject({ state: "upcoming", seconds: null });
  });

  it("does not move the current segment back on a planner answer", () => {
    const t = task({
      steps: steps(["Planner", 0], ["Developer", 10], ["Planner (answering developer)", 30]),
    });
    const r = byRole(stepStrip(t, T0 + 40_000));
    expect(r.developer.state).toBe("current");
    expect(r.planner.state).toBe("done");
  });

  it("counts only the last iteration of a multi-run task", () => {
    const t = task({
      runs: 2,
      completedRuns: 1,
      steps: steps(
        ["Planner", 0],
        ["Developer", 10],
        ["Observer (round 1)", 20],
        ["Reviewer (round 1)", 30],
        ["Planner", 100],
      ),
    });
    const r = byRole(stepStrip(t, T0 + 110_000));
    expect(r.planner.state).toBe("current");
    expect(r.developer.state).toBe("upcoming");
    expect(r.observer.state).toBe("upcoming");
    expect(r.reviewer.state).toBe("upcoming");
  });
});

describe("runLabel", () => {
  it("shows the iteration only for multi-run tasks", () => {
    expect(runLabel(task({ runs: 1 }))).toBeNull();
    expect(runLabel(task({ runs: 3, completedRuns: 1 }))).toBe("run 2 of 3");
    expect(runLabel(task({ runs: 3, completedRuns: 3 }))).toBe("run 3 of 3");
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(42)).toBe("42s");
    expect(formatDuration(252)).toBe("4m 12s");
    expect(formatDuration(3780)).toBe("1h 3m");
    expect(formatDuration(-5)).toBe("0s");
  });
});
