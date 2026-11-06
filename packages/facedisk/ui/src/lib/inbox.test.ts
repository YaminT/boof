import { describe, expect, it } from "vitest";
import type { PlanSummary, TaskView } from "../api.js";
import { inboxCount, inboxGroups } from "./inbox.js";
import type { NeedsYouItem } from "./task-groups.js";

const task = (projectId: string, id: string, created = "2026-01-01T00:00:00.000Z"): TaskView =>
  ({ projectId, frontmatter: { id, title: id, created } }) as unknown as TaskView;
const plan = { id: "p", title: "P", status: "draft" } as unknown as PlanSummary;
const projects = [
  { id: "alpha", name: "Alpha" },
  { id: "beta", name: "Beta" },
];

describe("inboxGroups", () => {
  it("puts the selected project first, then the rest by name", () => {
    const g = inboxGroups(
      [task("beta", "b1"), task("beta", "b2"), task("alpha", "a1")],
      { pid: "alpha", needsYou: [] },
      projects,
    );
    expect(g.map((x) => x.pid)).toEqual(["alpha", "beta"]);
    expect(g[1].items).toHaveLength(2);
  });
  it("orders other projects by name when the selected one has nothing", () => {
    const g = inboxGroups(
      [task("beta", "b1"), task("alpha", "a1")],
      { pid: "zed", needsYou: [] },
      projects,
    );
    expect(g.map((x) => x.pid)).toEqual(["alpha", "beta"]);
  });
  it("does not repeat a question that is in both lists", () => {
    const q = task("alpha", "a1");
    const needsYou: NeedsYouItem[] = [{ kind: "question", task: q }];
    const g = inboxGroups([q], { pid: "alpha", needsYou }, projects);
    expect(inboxCount(g)).toBe(1);
  });
  it("adds proposed tasks and draft plans of the selected project after its questions", () => {
    const needsYou: NeedsYouItem[] = [
      { kind: "proposed", task: task("alpha", "pr") },
      { kind: "draft-plan", plan },
    ];
    const g = inboxGroups([task("alpha", "a1")], { pid: "alpha", needsYou }, projects);
    expect(g[0].items.map((i) => i.kind)).toEqual(["question", "proposed", "draft-plan"]);
  });
  it("sorts questions oldest first", () => {
    const g = inboxGroups(
      [
        task("alpha", "new", "2026-02-01T00:00:00.000Z"),
        task("alpha", "old", "2026-01-01T00:00:00.000Z"),
      ],
      null,
      projects,
    );
    expect(g[0].items.map((i) => (i.kind === "question" ? i.task.frontmatter.id : ""))).toEqual([
      "old",
      "new",
    ]);
  });
  it("names an unknown project by its id", () => {
    expect(inboxGroups([task("gone", "x")], null, projects)[0].name).toBe("gone");
  });
  it("counts items and gives nothing for nothing", () => {
    expect(inboxGroups([], null, [])).toEqual([]);
    expect(inboxCount(inboxGroups([task("alpha", "a"), task("beta", "b")], null, projects))).toBe(
      2,
    );
  });
});
