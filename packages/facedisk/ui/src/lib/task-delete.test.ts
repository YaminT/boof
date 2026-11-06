import { describe, expect, it } from "vitest";
import { ApiError } from "../api.js";
import {
  deleteDialogModel,
  hasChildrenConflict,
  serverSubtaskCount,
  shownSubtasks,
} from "./task-delete.js";

describe("deleteDialogModel", () => {
  it("is the ordinary delete for a task without subtasks", () => {
    expect(deleteDialogModel(0, false)).toEqual({
      detach: false,
      title: "Delete task",
      body: "Delete this task? Its file, reports and log are removed. This cannot be undone.",
      confirmLabel: "Delete task",
    });
  });

  it("makes the user choose to detach when there are subtasks, and says how many", () => {
    const one = deleteDialogModel(1, false);
    expect(one.detach).toBe(true);
    expect(one.confirmLabel).toBe("Delete and detach subtasks");
    expect(one.body).toContain("1 subtask.");
    expect(one.body).toMatch(/become top-level tasks/);
    expect(deleteDialogModel(3, false).body).toContain("3 subtasks.");
  });

  it("asks again, with the detach choice, when the server found subtasks the page did not know of", () => {
    const m = deleteDialogModel(0, true);
    expect(m.detach).toBe(true);
    expect(m.confirmLabel).toBe("Delete and detach subtasks");
    expect(m.body).toMatch(/has subtasks/);
  });
});

describe("hasChildrenConflict", () => {
  it("is the 409 that says subtasks block the delete", () => {
    expect(hasChildrenConflict(new ApiError("x", 409, "has_children"))).toBe(true);
    expect(hasChildrenConflict(new ApiError("x", 409, "task_modified"))).toBe(false);
    expect(hasChildrenConflict(new ApiError("x", 403, "has_children"))).toBe(false);
    expect(hasChildrenConflict(new Error("x"))).toBe(false);
    expect(hasChildrenConflict(undefined)).toBe(false);
  });
});

describe("server count", () => {
  it("reads the count from the refusal and shows the larger of it and what the page knows", () => {
    const e = new ApiError(
      "Task a has 4 subtask(s); pass detach to keep them",
      409,
      "has_children",
    );
    expect(serverSubtaskCount(e)).toBe(4);
    expect(serverSubtaskCount(new ApiError("nope", 409, "has_children"))).toBeNull();
    expect(serverSubtaskCount(new Error("x"))).toBeNull();
    expect(shownSubtasks(2, 4)).toBe(4);
    expect(shownSubtasks(5, 4)).toBe(5);
    expect(shownSubtasks(0, null)).toBe(0);
    expect(deleteDialogModel(shownSubtasks(0, 4), true).body).toContain("4 subtasks.");
  });
});
