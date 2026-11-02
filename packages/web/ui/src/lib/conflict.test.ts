import { describe, expect, it } from "vitest";
import { ApiError } from "../api.js";
import { conflictOf } from "./conflict.js";

describe("conflictOf", () => {
  it("recognises plan and task conflicts", () => {
    expect(conflictOf(new ApiError("x", 409, "plan_version_conflict"))).toBe("plan");
    expect(conflictOf(new ApiError("x", 409, "task_modified"))).toBe("task");
  });
  it("is null for everything else", () => {
    expect(conflictOf(new ApiError("x", 409, "goal_has_dependents"))).toBeNull();
    expect(conflictOf(new ApiError("x", 400, "task_modified"))).toBeNull();
    expect(conflictOf(new Error("boom"))).toBeNull();
    expect(conflictOf(undefined)).toBeNull();
  });
});
