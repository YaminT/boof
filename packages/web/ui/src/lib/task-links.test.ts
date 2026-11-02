import { describe, expect, it } from "vitest";
import type { EpicView, TaskView } from "../api.js";
import { parseRoute } from "./route.js";
import {
  childTasks,
  epicFromSearch,
  hierarchyLine,
  newSubtaskHref,
  parentFromSearch,
  tasksForEpicHref,
} from "./task-links.js";

const task = (id: string, o: Partial<TaskView> = {}, f: Record<string, unknown> = {}) =>
  ({
    projectId: "p",
    frontmatter: { id, title: `T ${id}`, status: "draft", ...f },
    body: {},
    ...o,
  }) as unknown as TaskView;
const epic = (id: string, title = id) => ({ id, title, archived: false }) as unknown as EpicView;

describe("links", () => {
  it("builds hrefs that are valid routes", () => {
    expect(tasksForEpicHref("my proj", "checkout")).toBe("p/my%20proj/tasks?epic=checkout");
    expect(parseRoute(tasksForEpicHref("boof", "e").split("?")[0]!)).toEqual({
      name: "tasks",
      pid: "boof",
    });
    expect(newSubtaskHref("boof", "parent-1")).toBe("p/boof/tasks/__new__?parent=parent-1");
    expect(parseRoute(newSubtaskHref("boof", "x").split("?")[0]!)).toMatchObject({
      name: "task",
      taskId: "__new__",
    });
  });

  it("reads the epic and parent back from the query, and only valid ids", () => {
    expect(epicFromSearch("?epic=checkout")).toBe("checkout");
    expect(epicFromSearch("?epic=none")).toBe("none");
    expect(epicFromSearch("")).toBeNull();
    expect(epicFromSearch("?epic=../x")).toBeNull();
    expect(epicFromSearch("?epic=")).toBeNull();
    expect(parentFromSearch("?parent=fix-login")).toBe("fix-login");
    expect(parentFromSearch("?parent=Bad Id")).toBeNull();
    expect(parentFromSearch("?x=1")).toBeNull();
  });
});

describe("childTasks", () => {
  it("lists a task's subtasks, with how many are done (archived ones left out)", () => {
    const all = [
      task("a"),
      task("c1", {}, { parentId: "a", status: "done" }),
      task("c2", {}, { parentId: "a", status: "running" }),
      task("c3", {}, { parentId: "a", status: "archived" }),
      task("z", {}, { parentId: "other" }),
    ];
    const r = childTasks(all, "a");
    expect(r.items.map((t) => t.frontmatter.id)).toEqual(["c1", "c2", "c3"]);
    expect(r.progress).toEqual({ done: 1, total: 2 });
  });
  it("has no progress without children", () => {
    expect(childTasks([task("a")], "a")).toEqual({ items: [], progress: null });
  });
});

describe("hierarchyLine", () => {
  const epics = new Map([["checkout", epic("checkout", "Checkout rework")]]);
  const all = [task("a", {}, {}), task("c", { epicId: "checkout" }, { parentId: "a" })];

  it("names the epic and the parent", () => {
    const l = hierarchyLine(all[1]!, epics, all);
    expect(l.epic).toEqual({
      id: "checkout",
      title: "Checkout rework",
      missing: false,
      inherited: true,
    });
    expect(l.parent).toEqual({ id: "a", title: "T a", missing: false });
  });

  it("marks an epic the task owns versus one it takes from its parent", () => {
    const own = task("o", { epicId: "checkout" }, { epicId: "checkout" });
    expect(hierarchyLine(own, epics, [own]).epic?.inherited).toBe(false);
  });

  it("flags a missing epic (using the id as its name) and a missing parent", () => {
    const t = task(
      "m",
      { epicId: "ghost", epicMissing: true, parentMissing: true },
      { parentId: "gone", epicId: "ghost" },
    );
    const l = hierarchyLine(t, epics, [t]);
    expect(l.epic).toEqual({ id: "ghost", title: "ghost", missing: true, inherited: false });
    expect(l.parent).toEqual({ id: "gone", title: "gone", missing: true });
  });

  it("has nothing for a plain task", () => {
    expect(hierarchyLine(task("p"), epics, [])).toEqual({ epic: null, parent: null });
  });
});
