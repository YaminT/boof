import { describe, expect, it } from "vitest";
import type { PlanSummary, TaskView } from "../api.js";
import { groupTasks } from "./task-groups.js";

function task(p: {
  id: string;
  status?: string;
  priority?: number;
  skip?: boolean;
  created?: string;
  updated?: string;
  origin?: "ui" | "cli" | "api" | "mcp";
}): TaskView {
  return {
    projectId: "p",
    frontmatter: {
      id: p.id,
      title: p.id,
      status: p.status ?? "pending",
      priority: p.priority ?? 0,
      skip: p.skip ?? false,
      labels: [],
      created: p.created ?? "2026-01-01T00:00:00Z",
      updated: p.updated ?? "2026-01-01T00:00:00Z",
      ...(p.origin ? { origin: { kind: p.origin } } : {}),
    },
    body: { prompt: "", log: "" },
  } as unknown as TaskView;
}
const plan = (id: string, status: string, created: string): PlanSummary =>
  ({
    id,
    title: id,
    status,
    created,
    updated: created,
    goalCount: 0,
    doneCount: 0,
  }) as unknown as PlanSummary;
const ids = (ts: TaskView[]) => ts.map((t) => t.frontmatter.id);

describe("groupTasks", () => {
  it("is empty for no tasks", () => {
    expect(groupTasks([])).toEqual({
      needsYou: [],
      running: [],
      queued: [],
      drafts: [],
      finished: { counts: { done: 0, failed: 0, stopped: 0, archived: 0 }, recent: [] },
    });
  });

  it("keeps every running task", () => {
    const g = groupTasks([
      task({ id: "a", status: "running" }),
      task({ id: "b", status: "running" }),
    ]);
    expect(ids(g.running)).toEqual(["a", "b"]);
  });

  it("orders needsYou: questions, proposed drafts, draft plans, oldest first", () => {
    const g = groupTasks(
      [
        task({ id: "q2", status: "action", created: "2026-01-03T00:00:00Z" }),
        task({ id: "pr-mcp", status: "draft", origin: "mcp", created: "2026-01-02T00:00:00Z" }),
        task({ id: "q1", status: "action", created: "2026-01-02T00:00:00Z" }),
        task({ id: "pr-api", status: "draft", origin: "api", created: "2026-01-01T00:00:00Z" }),
      ],
      [
        plan("pl2", "draft", "2026-01-02T00:00:00Z"),
        plan("pl1", "draft", "2026-01-01T00:00:00Z"),
        plan("x", "active", "2025-01-01T00:00:00Z"),
      ],
    );
    expect(
      g.needsYou.map((i) => (i.kind === "draft-plan" ? i.plan.id : i.task.frontmatter.id)),
    ).toEqual(["q1", "q2", "pr-api", "pr-mcp", "pl1", "pl2"]);
    expect(g.needsYou.map((i) => i.kind)).toEqual([
      "question",
      "question",
      "proposed",
      "proposed",
      "draft-plan",
      "draft-plan",
    ]);
  });

  it("puts ui and cli drafts in drafts, not needsYou", () => {
    const g = groupTasks([
      task({ id: "ui", status: "draft", origin: "ui" }),
      task({ id: "none", status: "draft" }),
    ]);
    expect(g.needsYou).toEqual([]);
    expect(ids(g.drafts)).toEqual(["ui", "none"]);
  });

  it("orders queued like the runner and omits skipped", () => {
    const g = groupTasks([
      task({ id: "c", priority: 0, updated: "2026-01-01T00:00:00Z" }),
      task({ id: "b", priority: 5, updated: "2026-01-02T00:00:00Z" }),
      task({ id: "a2", priority: 5, updated: "2026-01-01T00:00:00Z" }),
      task({ id: "a1", priority: 5, updated: "2026-01-01T00:00:00Z" }),
      task({ id: "s", priority: 9, skip: true }),
    ]);
    expect(ids(g.queued)).toEqual(["a1", "a2", "b", "c"]);
  });

  it("counts finished, with recent limited and archived only counted", () => {
    const g = groupTasks(
      [
        task({ id: "d1", status: "done", updated: "2026-01-01T00:00:00Z" }),
        task({ id: "d2", status: "done", updated: "2026-01-05T00:00:00Z" }),
        task({ id: "f", status: "failed", updated: "2026-01-04T00:00:00Z" }),
        task({ id: "s", status: "stopped", updated: "2026-01-03T00:00:00Z" }),
        task({ id: "ar", status: "archived", updated: "2026-01-09T00:00:00Z" }),
      ],
      [],
      { recentLimit: 3 },
    );
    expect(g.finished.counts).toEqual({ done: 2, failed: 1, stopped: 1, archived: 1 });
    expect(ids(g.finished.recent)).toEqual(["d2", "f", "s"]);
    expect(groupTasks([task({ id: "x", status: "done" })]).finished.recent).toHaveLength(1);
  });
});
