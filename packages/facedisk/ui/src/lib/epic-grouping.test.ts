import { describe, expect, it } from "vitest";
import type { EpicView, TaskView } from "../api.js";
import {
  groupTasksByEpic,
  isCollapsed,
  readCollapsed,
  readGrouping,
  reorderWithinGroup,
  writeCollapsed,
  writeGrouping,
} from "./epic-grouping.js";

const task = (id: string, epicId?: string) =>
  ({ projectId: "p", frontmatter: { id, title: id }, body: {}, epicId }) as unknown as TaskView;
const epic = (id: string, o: Partial<EpicView> = {}): EpicView =>
  ({
    id,
    title: `E ${id}`,
    priority: 0,
    archived: false,
    updated: "2026-01-01T00:00:00.000Z",
    progress: { done: 1, total: 3 },
    ...o,
  }) as EpicView;

describe("groupTasksByEpic", () => {
  it("orders epics by priority, then oldest update, then id; 'No epic' comes last", () => {
    const epics = [
      epic("b", { priority: 5 }),
      epic("a", { priority: 5 }),
      epic("hi", { priority: 9 }),
      epic("old", { priority: 5, updated: "2025-01-01T00:00:00.000Z" }),
    ];
    const tasks = [
      task("t0"),
      task("t1", "b"),
      task("t2", "a"),
      task("t3", "hi"),
      task("t4", "old"),
    ];
    expect(groupTasksByEpic(tasks, epics).map((s) => s.key)).toEqual([
      "hi",
      "old",
      "a",
      "b",
      "none",
    ]);
  });

  it("keeps the order of the tasks inside each group", () => {
    const tasks = [task("z", "a"), task("m"), task("y", "a"), task("n")];
    const s = groupTasksByEpic(tasks, [epic("a")]);
    expect(s.map((x) => x.tasks.map((t) => t.frontmatter.id))).toEqual([
      ["z", "y"],
      ["m", "n"],
    ]);
  });

  it("leaves out epics with no task here, and has no 'No epic' section when nothing lacks one", () => {
    const s = groupTasksByEpic([task("t", "a")], [epic("a"), epic("empty")]);
    expect(s.map((x) => x.key)).toEqual(["a"]);
  });

  it("puts a task whose epic does not exist under 'No epic'", () => {
    const s = groupTasksByEpic([task("t", "ghost")], [epic("a")]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ key: "none", epic: null, progress: null });
  });

  it("shows the epic's own progress (over the whole project), and flags an archived epic", () => {
    const s = groupTasksByEpic(
      [task("t", "a")],
      [epic("a", { archived: true, progress: { done: 3, total: 7 } })],
    );
    expect(s[0]).toMatchObject({ progress: { done: 3, total: 7 }, archived: true });
  });

  it("gives nothing for no tasks", () => {
    expect(groupTasksByEpic([], [epic("a")])).toEqual([]);
  });
});

describe("reorderWithinGroup", () => {
  it("permutes only the group's slots in the whole order", () => {
    expect(reorderWithinGroup(["a", "x", "b", "y", "c"], ["a", "b", "c"], ["c", "a", "b"])).toEqual(
      ["c", "x", "a", "y", "b"],
    );
  });
  it("is a no-op for the same order, and ignores ids that are not in the group", () => {
    const flat = ["a", "x", "b"];
    expect(reorderWithinGroup(flat, ["a", "b"], ["a", "b"])).toEqual(flat);
    expect(reorderWithinGroup(flat, ["a", "b"], ["b", "a", "zzz"])).toEqual(["b", "x", "a"]);
  });
});

function memory(init: Record<string, string> = {}, throws = false) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => {
      if (throws) throw new Error("denied");
      return m.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (throws) throw new Error("denied");
      m.set(k, v);
    },
  };
}

describe("grouping preference", () => {
  it("defaults to off and is remembered per project", () => {
    const store = memory();
    expect(readGrouping(store, "a")).toBe(false);
    writeGrouping(store, "a", true);
    expect(readGrouping(store, "a")).toBe(true);
    expect(readGrouping(store, "b")).toBe(false);
    writeGrouping(store, "a", false);
    expect(readGrouping(store, "a")).toBe(false);
  });
  it("works without storage", () => {
    expect(readGrouping(null, "a")).toBe(false);
    expect(() => writeGrouping(null, "a", true)).not.toThrow();
    const denied = memory({}, true);
    expect(readGrouping(denied, "a")).toBe(false);
    expect(() => writeGrouping(denied, "a", true)).not.toThrow();
  });
});

describe("collapsed groups", () => {
  it("remembers per project, ignores junk, and collapses an archived epic by default", () => {
    const store = memory();
    writeCollapsed(store, "a", { x: true, y: false });
    expect(readCollapsed(store, "a")).toEqual({ x: true, y: false });
    expect(readCollapsed(store, "b")).toEqual({});
    expect(readCollapsed(memory({ "boof.epicCollapsed.a": "{not json" }), "a")).toEqual({});
    expect(readCollapsed(memory({ "boof.epicCollapsed.a": '{"x":1,"y":true}' }), "a")).toEqual({
      y: true,
    });
    const sections = groupTasksByEpic(
      [task("t", "arch"), task("u", "live")],
      [epic("arch", { archived: true }), epic("live")],
    );
    const [arch, live] = [
      sections.find((s) => s.key === "arch")!,
      sections.find((s) => s.key === "live")!,
    ];
    expect(isCollapsed({}, arch)).toBe(true);
    expect(isCollapsed({}, live)).toBe(false);
    expect(isCollapsed({ arch: false }, arch)).toBe(false);
    expect(isCollapsed({ live: true }, live)).toBe(true);
  });
});
