import { describe, expect, it } from "vitest";
import { ApiError, type TaskView } from "../api.js";
import { epicDetachNote, epicUsage, needsDetach, parseEpicForm } from "./epics-manage.js";

describe("parseEpicForm", () => {
  it("trims the title and reads the priority (default 0, negatives allowed)", () => {
    expect(parseEpicForm({ title: "  Checkout  ", priority: "" })).toEqual({
      ok: true,
      value: { title: "Checkout", priority: 0 },
    });
    expect(parseEpicForm({ title: "x", priority: "-3" })).toEqual({
      ok: true,
      value: { title: "x", priority: -3 },
    });
  });
  it("names each problem", () => {
    expect(parseEpicForm({ title: "  ", priority: "1.5" })).toEqual({
      ok: false,
      problems: ["Name the epic.", "Priority is a whole number."],
    });
    expect(parseEpicForm({ title: "x".repeat(201), priority: "0" })).toEqual({
      ok: false,
      problems: ["The name is at most 200 characters."],
    });
  });
});

describe("needsDetach", () => {
  it("is true only for the 409 that says tasks still name the epic", () => {
    expect(needsDetach(new ApiError("has tasks", 409, "has_tasks"))).toBe(true);
    expect(needsDetach(new ApiError("stale", 409, "epic_modified"))).toBe(false);
    expect(needsDetach(new ApiError("nope", 404, "has_tasks"))).toBe(false);
    expect(needsDetach(new Error("x"))).toBe(false);
  });
});

describe("epicUsage", () => {
  const t = (id: string, o: { own?: string; effective?: string; parent?: string }) =>
    ({
      frontmatter: { id, epicId: o.own, parentId: o.parent },
      epicId: o.effective ?? o.own,
    }) as unknown as TaskView;
  it("counts the tasks that name the epic and, apart, the subtasks that take it from a parent", () => {
    const tasks = [
      t("a", { own: "e" }),
      t("b", { own: "e" }),
      t("kid1", { effective: "e", parent: "a" }),
      t("kid2", { effective: "e", parent: "a" }),
      t("kid3", { effective: "e", parent: "b" }),
      t("other", { own: "f" }),
      t("kid4", { effective: "f", parent: "other" }),
    ];
    expect(epicUsage(tasks, "e")).toEqual({ tasks: 2, subtasks: 3 });
    expect(epicUsage(tasks, "none")).toEqual({ tasks: 0, subtasks: 0 });
  });
});

describe("epicDetachNote", () => {
  it("names the tasks and their subtasks", () => {
    expect(epicDetachNote("Checkout rework", { tasks: 1, subtasks: 3 })).toBe(
      "1 task and its 3 subtasks use \u201cCheckout rework\u201d. Archive it to keep the grouping, or delete it: that clears the epic on them, and nothing else changes.",
    );
    expect(epicDetachNote("X", { tasks: 2, subtasks: 1 })).toContain(
      "2 tasks and their 1 subtask use",
    );
  });
  it("is plain for tasks without subtasks", () => {
    expect(epicDetachNote("X", { tasks: 1, subtasks: 0 })).toContain("1 task uses \u201cX\u201d");
    expect(epicDetachNote("X", { tasks: 1, subtasks: 0 })).toContain("on that task");
    expect(epicDetachNote("X", { tasks: 3, subtasks: 0 })).toContain("3 tasks use");
  });
});
