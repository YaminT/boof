import { describe, expect, it } from "vitest";
import { newTask } from "./task-file.js";
import { parseReviewRounds, taskReviewInfo } from "./task-reviews.js";

const task = (over: { observer?: string; reviewer?: string; log?: string } = {}) => {
  const t = newTask(
    {
      id: "t1",
      title: "T",
      status: "done",
      priority: 1,
      skip: false,
      labels: [],
      command: null,
      attachments: [],
      questions: "none",
      runs: 1,
      completedRuns: 1,
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
    },
    "p",
  );
  t.body.reports.observer = over.observer ?? "";
  t.body.reports.reviewer = over.reviewer ?? "";
  t.body.log = over.log ?? "";
  return t;
};

describe("parseReviewRounds", () => {
  it("reads round, verdict, iteration and the first non-heading line", () => {
    const report = [
      "#### Round 1 — CHANGES_REQUESTED\n## Findings\n\n  Add a test.  \nVERDICT: CHANGES_REQUESTED",
      "#### Round 2 — APPROVE\nLooks good.\nVERDICT: APPROVE",
      "#### Round 1 — INVALID (iteration 2)\n\nNo verdict line.",
    ].join("\n\n");
    expect(parseReviewRounds("reviewer", report)).toEqual([
      {
        role: "reviewer",
        round: 1,
        iteration: 1,
        verdict: "CHANGES_REQUESTED",
        summary: "Add a test.",
      },
      { role: "reviewer", round: 2, iteration: 1, verdict: "APPROVE", summary: "Looks good." },
      { role: "reviewer", round: 1, iteration: 2, verdict: "INVALID", summary: "No verdict line." },
    ]);
  });

  it("ignores text that is not a round block and an empty report", () => {
    expect(parseReviewRounds("observer", "")).toEqual([]);
    expect(parseReviewRounds("observer", "free text\n#### Round x — APPROVE")).toEqual([]);
  });

  it("shortens a very long summary line", () => {
    const [r] = parseReviewRounds("observer", `#### Round 1 — REJECT\n${"x".repeat(1000)}`);
    expect(r!.summary.length).toBeLessThanOrEqual(400);
  });
});

describe("taskReviewInfo", () => {
  it("lists observer rounds then reviewer rounds and takes each role's last verdict", () => {
    const info = taskReviewInfo(
      task({
        observer: "#### Round 1 — REJECT\nBad.",
        reviewer: "#### Round 1 — CHANGES_REQUESTED\nFix.\n\n#### Round 2 — APPROVE\nOk.",
        log: "Iteration 1/1 — worktree at /w\nbase main → abcdef1234567\n\nmore",
      }),
    );
    expect(info.reviews.map((r) => `${r.role}:${r.round}:${r.verdict}`)).toEqual([
      "observer:1:REJECT",
      "reviewer:1:CHANGES_REQUESTED",
      "reviewer:2:APPROVE",
    ]);
    expect(info.finalVerdict).toEqual({ observer: "REJECT", reviewer: "APPROVE" });
    expect(info.branch).toBe("boof-runner/t1");
    expect(info.baseSha).toBe("abcdef1234567");
  });

  it("reads baseRef from the base line and baseReason from the ## Base block", () => {
    const base = (line: string) =>
      taskReviewInfo(task({ log: `## Base\n${line}\n\nbase feat/x → abcdef1234567` }));
    expect(
      base("Base: feat/x (the project default base; no finished dependency branch found)."),
    ).toMatchObject({
      baseRef: "feat/x",
      baseReason: "project-default",
    });
    const cases: [string, string][] = [
      ["Base: b (the finished branch of this goal's previous task).", "follow-up"],
      ["Base: b (the finished branch of goal a, which this goal depends on).", "dependency"],
      ["Base: b--base (merge of b (goal a), c (goal d)).", "dependencies-merged"],
      [
        "Base: b (first dependency; no integration branch because conflict). Other.",
        "dependency-conflict",
      ],
      [
        "Base: HEAD of the project repository (no finished dependency branch and no default base).",
        "head",
      ],
    ];
    for (const [line, reason] of cases) expect(base(line).baseReason).toBe(reason);
    expect(taskReviewInfo(task({ log: "base HEAD → abcdef1234567" })).baseRef).toBe("HEAD");
    expect(taskReviewInfo(task({})).baseReason).toBeUndefined();
  });

  it("has no branch or baseSha for a task that never ran, and omits roles that did not review", () => {
    const info = taskReviewInfo(task({ reviewer: "#### Round 1 — APPROVE\nOk." }));
    expect(info.finalVerdict).toEqual({ reviewer: "APPROVE" });
    expect(info.branch).toBeUndefined();
    expect(info.baseSha).toBeUndefined();
    expect(taskReviewInfo(task({ log: "Iteration 1/1 — worktree at /w" })).branch).toBe(
      "boof-runner/t1",
    );
  });
});
