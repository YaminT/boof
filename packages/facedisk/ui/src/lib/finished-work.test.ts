import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Goal } from "../api.js";
import { FinishedWorkNote } from "../plans/FinishedWorkNote.js";
import { finishedWork } from "./finished-work.js";

const goal = (id: string, order: number, status: Goal["status"], branch?: string) =>
  ({
    id,
    order,
    status,
    tasks: branch ? [{ taskId: id, revision: 1, status: "done", branch }] : [],
  }) as unknown as Goal;

describe("finishedWork", () => {
  it("names the last stacked branch and a merge command", () => {
    const w = finishedWork([
      goal("b", 2, "done", "boof-runner/b"),
      goal("a", 1, "done", "boof-runner/a"),
    ]);
    expect(w).toEqual({
      branch: "boof-runner/b",
      branches: ["boof-runner/a", "boof-runner/b"],
      mergeCommand: "git merge boof-runner/b",
    });
  });
  it("is null while a goal is open, with no goals, or with no branch", () => {
    expect(
      finishedWork([goal("a", 1, "done", "boof-runner/a"), goal("b", 2, "develop")]),
    ).toBeNull();
    expect(finishedWork([])).toBeNull();
    expect(finishedWork([goal("a", 1, "done")])).toBeNull();
  });
  it("renders the note only for a finished plan", () => {
    const done = renderToStaticMarkup(
      h(FinishedWorkNote, { goals: [goal("a", 1, "done", "boof-runner/a")] }),
    );
    expect(done).toContain("boof-runner/a");
    expect(done).toContain("git merge boof-runner/a");
    expect(
      renderToStaticMarkup(h(FinishedWorkNote, { goals: [goal("a", 1, "review", "x")] })),
    ).toBe("");
  });
});
