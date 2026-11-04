import { describe, expect, it } from "vitest";
import { ApiError } from "../api.js";
import { conflictOf, overwriteStatus } from "./conflict.js";

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

describe("overwriteStatus", () => {
  it("repeats the refused save's status during an open conflict", () => {
    expect(overwriteStatus(true, "pending")).toBe("pending");
    expect(overwriteStatus(true, undefined)).toBeUndefined();
  });
  it("drops it once the conflict is over: Queue, 409, Reload, edit, live change, Overwrite", () => {
    // After Reload the conflict flag is false, so a leftover status must not be used.
    expect(overwriteStatus(false, "pending")).toBeUndefined();
  });
});
