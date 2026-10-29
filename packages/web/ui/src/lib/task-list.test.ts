import { describe, expect, it } from "vitest";
import type { TaskView } from "../api.js";
import { allLabels, filterTasks, listKeyAction, moveQueued, type TaskFilter } from "./task-list.js";

const mk = (
  id: string,
  status: string,
  o: { title?: string; labels?: string[]; origin?: string } = {},
) =>
  ({
    frontmatter: {
      id,
      title: o.title ?? `Title ${id}`,
      status,
      labels: o.labels ?? [],
      origin: o.origin ? { kind: o.origin } : undefined,
    },
  }) as unknown as TaskView;

const all: TaskFilter = { query: "", state: "all", label: null };
const tasks = [
  mk("t-1", "action", { title: "Fix Login", labels: ["bug"] }),
  mk("t-2", "draft", { origin: "mcp", labels: ["ux"] }),
  mk("t-3", "draft", { origin: "human" }),
  mk("t-4", "running", { labels: ["bug", "ux"] }),
  mk("t-5", "pending"),
  mk("t-6", "done"),
  mk("t-7", "archived"),
];
const ids = (ts: TaskView[]) => ts.map((t) => t.frontmatter.id);

const key = (
  k: string,
  o: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {},
) => ({
  key: k,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...o,
});

describe("listKeyAction", () => {
  it("maps keys", () => {
    expect(listKeyAction(key("j"), false, false)).toBe("down");
    expect(listKeyAction(key("k"), false, false)).toBe("up");
    expect(listKeyAction(key("Enter"), false, false)).toBe("open");
    expect(listKeyAction(key("q"), false, false)).toBe("queue");
    expect(listKeyAction(key("s"), false, false)).toBe("stop");
    expect(listKeyAction(key("ArrowUp", { altKey: true }), false, false)).toBe("move-up");
    expect(listKeyAction(key("ArrowDown", { altKey: true }), false, false)).toBe("move-down");
  });
  it("is silent while typing or in a dialog", () => {
    for (const k of [key("j"), key("Enter"), key("ArrowUp", { altKey: true })]) {
      expect(listKeyAction(k, true, false)).toBeNull();
      expect(listKeyAction(k, false, true)).toBeNull();
    }
  });
  it("ignores modified keys", () => {
    expect(listKeyAction(key("j", { ctrlKey: true }), false, false)).toBeNull();
    expect(listKeyAction(key("j", { metaKey: true }), false, false)).toBeNull();
    expect(listKeyAction(key("J", { shiftKey: true }), false, false)).toBeNull();
    expect(listKeyAction(key("ArrowUp"), false, false)).toBeNull();
  });
});

describe("moveQueued", () => {
  it("moves and bounds", () => {
    expect(moveQueued(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveQueued(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveQueued(["a", "b", "c"], "a", -1)).toBeNull();
    expect(moveQueued(["a", "b", "c"], "c", 1)).toBeNull();
    expect(moveQueued(["a", "b", "c"], "x", 1)).toBeNull();
  });
});

describe("filterTasks", () => {
  it("matches query on title and id, case-insensitive, trimmed", () => {
    expect(ids(filterTasks(tasks, { ...all, query: "  fix login " }))).toEqual(["t-1"]);
    expect(ids(filterTasks(tasks, { ...all, query: "T-5" }))).toEqual(["t-5"]);
    expect(filterTasks(tasks, { ...all, query: "   " })).toHaveLength(tasks.length);
  });
  it("filters by state", () => {
    const s = (state: TaskFilter["state"]) => ids(filterTasks(tasks, { ...all, state }));
    expect(s("needs-you")).toEqual(["t-1", "t-2"]);
    expect(s("running")).toEqual(["t-4"]);
    expect(s("queued")).toEqual(["t-5"]);
    expect(s("drafts")).toEqual(["t-3"]);
    expect(s("finished")).toEqual(["t-6", "t-7"]);
    expect(s("all")).toHaveLength(7);
  });
  it("filters by label and combines", () => {
    expect(ids(filterTasks(tasks, { ...all, label: "ux" }))).toEqual(["t-2", "t-4"]);
    expect(ids(filterTasks(tasks, { query: "t-", state: "running", label: "bug" }))).toEqual([
      "t-4",
    ]);
    expect(filterTasks(tasks, { query: "t-", state: "running", label: "nope" })).toEqual([]);
  });
});

describe("allLabels", () => {
  it("dedupes and sorts", () => {
    expect(allLabels(tasks)).toEqual(["bug", "ux"]);
  });
});
