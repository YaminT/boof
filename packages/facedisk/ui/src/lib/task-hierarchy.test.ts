import { describe, expect, it } from "vitest";
import type { TaskView } from "../api.js";
import { groupSubtasks, progressLabel } from "./task-hierarchy.js";

const task = (id: string, extra: Partial<TaskView> = {}, parentId?: string, title = `T ${id}`) =>
  ({
    projectId: "p",
    frontmatter: { id, title, status: "draft", parentId },
    body: {},
    ...extra,
  }) as unknown as TaskView;

const ids = (rows: { task: TaskView }[]) => rows.map((r) => r.task.frontmatter.id);

describe("groupSubtasks", () => {
  it("puts children directly after their parent, indented, in their own order", () => {
    const section = [
      task("c2", {}, "a"),
      task("b"),
      task("a", { subtasks: { total: 5, done: 2 } }),
      task("c1", {}, "a"),
    ];
    const rows = groupSubtasks(section);
    expect(ids(rows)).toEqual(["b", "a", "c2", "c1"]);
    expect(rows.map((r) => r.child)).toEqual([false, false, true, true]);
    expect(rows.every((r) => r.parentRef === null)).toBe(true);
  });

  it("shows a parent's progress, and none for a task without subtasks", () => {
    const rows = groupSubtasks([task("a", { subtasks: { total: 5, done: 2 } }), task("b")]);
    expect(rows[0]!.progress).toEqual({ done: 2, total: 5 });
    expect(progressLabel(rows[0]!.progress!)).toBe("2/5");
    expect(rows[1]!.progress).toBeNull();
  });

  it("refers to a parent in another section by title and leaves the child where it is", () => {
    const parent = task("a", {}, undefined, "Ship it");
    const section = [task("x"), task("c", {}, "a"), task("y")];
    const rows = groupSubtasks(section, { all: [parent, ...section] });
    expect(ids(rows)).toEqual(["x", "c", "y"]);
    expect(rows[1]).toMatchObject({ child: false, parentRef: { id: "a", title: "Ship it" } });
  });

  it("keeps the order when the parent is filtered out of the list", () => {
    const section = [task("c2", {}, "a"), task("c1", {}, "a")];
    const rows = groupSubtasks(section, { all: [task("a", {}, undefined, "Parent")] });
    expect(ids(rows)).toEqual(["c2", "c1"]);
    expect(rows.map((r) => r.parentRef?.title)).toEqual(["Parent", "Parent"]);
  });

  it("falls back to the id when the parent's title is unknown", () => {
    const rows = groupSubtasks([task("c", {}, "ghost")]);
    expect(rows[0]!.parentRef).toEqual({ id: "ghost", title: "ghost" });
  });

  it("does not regroup when nesting is off (a reorderable queue), but still names the parent", () => {
    const section = [task("c", {}, "a"), task("a")];
    const rows = groupSubtasks(section, { nest: false });
    expect(ids(rows)).toEqual(["c", "a"]);
    expect(rows[0]).toMatchObject({ child: false, parentRef: { id: "a", title: "T a" } });
  });

  it("flags a missing parent or epic and gives no parent reference", () => {
    const rows = groupSubtasks([
      task("c", { parentMissing: true }, "gone"),
      task("e", { epicMissing: true, epicId: "nope" }),
    ]);
    expect(rows[0]).toMatchObject({ parentMissing: true, parentRef: null, child: false });
    expect(rows[1]).toMatchObject({ epicMissing: true, parentMissing: false });
  });

  it("never drops a row when the data nests deeper than one level", () => {
    const rows = groupSubtasks([task("g", {}, "c"), task("c", {}, "a"), task("a")]);
    expect(ids(rows).sort()).toEqual(["a", "c", "g"]);
  });

  it("is stable: the same input gives the same rows", () => {
    const section = [task("c", {}, "a"), task("a"), task("b")];
    expect(ids(groupSubtasks(section))).toEqual(ids(groupSubtasks(section)));
  });
});
