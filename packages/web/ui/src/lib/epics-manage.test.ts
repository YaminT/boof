import { describe, expect, it } from "vitest";
import { ApiError, type TaskView } from "../api.js";
import { epicTaskCount, needsDetach, parseEpicForm } from "./epics-manage.js";

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

describe("epicTaskCount", () => {
  it("counts the tasks that name the epic themselves (what detach would clear)", () => {
    const t = (id: string, epicId?: string, effective?: string) =>
      ({ frontmatter: { id, epicId }, epicId: effective ?? epicId }) as unknown as TaskView;
    expect(
      epicTaskCount([t("a", "e"), t("b", "e"), t("c", undefined, "e"), t("d", "f")], "e"),
    ).toBe(2);
  });
});
