import { describe, expect, it } from "vitest";
import { allowedTransitions, assertTransition, canTransition } from "./lifecycle.js";

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
    for (const s of ["draft", "pending", "action", "done", "failed"] as const) {
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

  it("done is terminal except for archiving", () => {
    expect(allowedTransitions("done")).toEqual(["archived"]);
  });
});
