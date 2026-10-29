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
const rev = (role: string, round: number, verdict: string, iteration = 1) => ({
  role,
  round,
  iteration,
  verdict,
  summary: "",
});
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

  it("keeps reviewed roles done during a fix round", () => {
    const t = task(
      {
        steps: steps(
          ["Planner", 0],
          ["Developer", 10],
          ["Observer (round 1)", 20],
          ["Reviewer (round 1)", 30],
          ["Developer (fix round 1, reviewer)", 40],
        ),
      },
      { reviews: [rev("observer", 1, "APPROVE"), rev("reviewer", 1, "REJECT")] },
    );
    const segs = stepStrip(t, T0 + 50_000);
    const r = byRole(segs);
    expect(r.planner.state).toBe("done");
    expect(r.developer.state).toBe("current");
    expect(r.observer.state).toBe("done");
    expect(r.reviewer).toMatchObject({ state: "done", verdict: "REJECT" });
    for (const s of segs) if (s.seconds !== null) expect(s.seconds).toBeGreaterThanOrEqual(0);
  });

  it("gives a finished task's last role no duration", () => {
    const t = task(
      {
        steps: steps(["Planner", 0], ["Developer", 50], ["Reviewer (round 1)", 200]),
        updated: at(260),
      },
      {},
      "done",
    );
    const r = byRole(stepStrip(t, T0 + 999_000));
    expect(r.reviewer).toMatchObject({ state: "done", seconds: null });
    expect(r.planner.seconds).toBe(50);
  });

  it("marks the last role reached as failed or stopped", () => {
    for (const status of ["failed", "stopped"] as const) {
      const t = task({ steps: steps(["Planner", 0], ["Developer", 10]) }, {}, status);
      const r = byRole(stepStrip(t, T0 + 99_000));
      expect(r.planner.state).toBe("done");
      expect(r.developer).toMatchObject({ state: status, seconds: null });
      expect(r.observer.state).toBe("upcoming");
      expect(r.reviewer.state).toBe("upcoming");
    }
  });

  it("marks the role that asked as waiting when the task needs you", () => {
    const t = task({ steps: steps(["Planner", 0], ["Developer", 10]) }, {}, "action");
    const r = byRole(stepStrip(t, T0 + 99_000));
    expect(r.planner.state).toBe("done");
    expect(r.developer.state).toBe("waiting");
    expect(r.reviewer.state).toBe("upcoming");
  });

  it("never marks a role that did not run as done", () => {
    const t = task(
      { steps: steps(["Planner", 0], ["Developer", 10], ["Reviewer (round 1)", 40]) },
      {},
      "done",
    );
    const r = byRole(stepStrip(t, T0 + 99_000));
    expect(r.observer).toMatchObject({ state: "skipped", seconds: null, verdict: null });
    expect(r.reviewer.state).toBe("done");
  });

  it("shows verdicts only on done observer and reviewer segments", () => {
    const t = task(
      {
        steps: steps(["Planner", 0], ["Developer", 10], ["Observer (round 1)", 20]),
      },
      { reviews: [rev("observer", 1, "APPROVE"), rev("reviewer", 1, "APPROVE")] },
      "done",
    );
    const r = byRole(stepStrip(t, T0 + 99_000));
    expect(r.observer).toMatchObject({ state: "done", verdict: "APPROVE" });
    expect(r.reviewer).toMatchObject({ state: "upcoming", verdict: null });
    expect(r.developer.verdict).toBeNull();
  });

  it("does not show the previous run's verdict after a retry or in a later run", () => {
    const old = { reviews: [rev("observer", 1, "APPROVE"), rev("reviewer", 1, "REJECT")] };
    // Retried: queued again, nothing of the old run counts.
    const retried = task({ steps: steps(["Planner", 0], ["Developer", 10]) }, old, "pending");
    for (const s of stepStrip(retried, T0)) expect(s).toMatchObject({ state: "upcoming" });
    // Second iteration of a multi-run task: iteration 1 reviews are stale.
    const second = task(
      {
        runs: 2,
        completedRuns: 1,
        steps: steps(["Planner", 100], ["Developer", 110], ["Observer (round 1)", 120]),
      },
      old,
    );
    const r = byRole(stepStrip(second, T0 + 130_000));
    expect(r.observer).toMatchObject({ state: "current", verdict: null });
    expect(r.reviewer.verdict).toBeNull();
    const later = byRole(
      stepStrip(
        task(
          {
            runs: 2,
            completedRuns: 1,
            steps: steps(
              ["Planner", 100],
              ["Developer", 110],
              ["Observer (round 1)", 120],
              ["Reviewer (round 1)", 130],
            ),
          },
          { reviews: [...old.reviews, rev("observer", 1, "APPROVE", 2)] },
        ),
        T0 + 140_000,
      ),
    );
    expect(later.observer).toMatchObject({ state: "done", verdict: "APPROVE" });
  });

  it("keeps the raw verdict", () => {
    const t = task(
      {
        steps: steps(
          ["Planner", 0],
          ["Developer", 5],
          ["Observer (round 1)", 10],
          ["Reviewer (round 1)", 20],
        ),
      },
      { reviews: [rev("observer", 1, "CHANGES_REQUESTED"), rev("reviewer", 1, "INVALID")] },
      "done",
    );
    const r = byRole(stepStrip(t, T0 + 99_000));
    expect(r.observer.verdict).toBe("CHANGES_REQUESTED");
    expect(r.reviewer.verdict).toBe("INVALID");
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
