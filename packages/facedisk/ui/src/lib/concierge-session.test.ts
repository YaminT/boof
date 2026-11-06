import { describe, expect, it } from "vitest";
import type { PendingChangeView } from "../api-types.js";
import { initialConciergeUi, reduceConcierge } from "./concierge-session.js";

const change: PendingChangeView = {
  id: "chg-0123abcd",
  op: "tasks.delete",
  title: 'Delete task "Fix" (t1)',
  details: ["The task is removed."],
  destructive: true,
  reason: "confirm",
  status: "pending",
  expiresAt: "2026-11-06T12:15:00.000Z",
};

describe("reduceConcierge", () => {
  it("joins text deltas into one assistant line", () => {
    let state = reduceConcierge(initialConciergeUi("p"), { type: "text", text: "Hel" });
    state = reduceConcierge(state, { type: "text", text: "lo" });
    expect(state.lines).toEqual([{ kind: "assistant", text: "Hello" }]);
  });

  it("lists a pending change and removes it when applied", () => {
    let state = reduceConcierge(initialConciergeUi("p"), { type: "pending", change });
    expect(state.pending).toEqual([change]);
    expect(state.lines.at(-1)).toEqual({
      kind: "pending",
      text: change.title,
      changeId: change.id,
    });
    state = reduceConcierge(state, { type: "applied", changeId: change.id });
    expect(state.pending).toEqual([]);
    expect(state.lines.at(-1)).toMatchObject({ kind: "pending", state: "applied" });
  });

  it("ends busy on an error and keeps the message as plain text", () => {
    const state = reduceConcierge(
      { ...initialConciergeUi("p"), busy: true },
      { type: "error", code: "concierge_unavailable", message: "no model <b>here</b>" },
    );
    expect(state.busy).toBe(false);
    expect(state.lines.at(-1)).toEqual({ kind: "system", text: "no model <b>here</b>" });
  });

  it("links a change to the task, plan or epic route", () => {
    const base = initialConciergeUi("my proj");
    const task = reduceConcierge(base, {
      type: "change",
      op: "tasks.create",
      summary: 'Created task "Fix" (t1)',
      target: { kind: "task", id: "t1" },
    });
    expect(task.lines.at(-1)).toEqual({
      kind: "change",
      text: 'Created task "Fix" (t1)',
      href: "p/my%20proj/tasks/t1",
    });
    const plan = reduceConcierge(base, {
      type: "change",
      op: "plans.update",
      summary: "Update plan",
      target: { kind: "plan", id: "plan-1" },
    });
    expect(plan.lines.at(-1)?.href).toBe("p/my%20proj/plans/plan-1");
    const epic = reduceConcierge(base, {
      type: "change",
      op: "epics.update",
      summary: "Update epic",
      target: { kind: "epic", id: "web" },
    });
    expect(epic.lines.at(-1)?.href).toBe("p/my%20proj/tasks?epic=web");
  });
});
