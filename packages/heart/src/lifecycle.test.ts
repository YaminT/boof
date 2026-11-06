import { describe, expect, it } from "vitest";
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  isUserTransition,
} from "./lifecycle.js";

describe("state machine", () => {
  it("allows the documented transitions", () => {
    expect(canTransition("draft", "pending")).toBe(true);
    expect(canTransition("pending", "running")).toBe(true);
    expect(canTransition("running", "action")).toBe(true);
    expect(canTransition("running", "done")).toBe(true);
    expect(canTransition("running", "failed")).toBe(true);
    expect(canTransition("action", "pending")).toBe(true);
    expect(canTransition("failed", "pending")).toBe(true);
  });

  it("allows archiving any non-running task and unarchiving", () => {
    for (const s of ["draft", "pending", "action", "done", "failed", "stopped"] as const) {
      expect(canTransition(s, "archived")).toBe(true);
    }
    expect(canTransition("running", "archived")).toBe(false);
    expect(canTransition("archived", "pending")).toBe(true);
  });

  it("rejects undocumented transitions", () => {
    expect(canTransition("done", "running")).toBe(false);
    expect(canTransition("draft", "done")).toBe(false);
    expect(canTransition("pending", "action")).toBe(false);
    expect(() => assertTransition("done", "running")).toThrow();
  });

  it("stopped is entered only from running and leaves by retry or archive", () => {
    expect(canTransition("running", "stopped")).toBe(true);
    for (const s of ["draft", "pending", "action", "done", "failed", "archived"] as const) {
      expect(canTransition(s, "stopped")).toBe(false);
    }
    expect(allowedTransitions("stopped")).toEqual(["pending", "archived"]);
    expect(() => assertTransition("stopped", "running")).toThrow();
    // A user can retry or archive a stopped task, but never set stopped by hand.
    expect(isUserTransition("stopped", "pending")).toBe(true);
    expect(isUserTransition("stopped", "archived")).toBe(true);
    expect(isUserTransition("running", "stopped")).toBe(false);
  });

  it("done is terminal except for archiving", () => {
    expect(allowedTransitions("done")).toEqual(["archived"]);
  });
});
