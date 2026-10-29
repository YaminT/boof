import { beforeEach, describe, expect, it } from "vitest";
import { markRunning, startedAt } from "./first-seen";

describe("first-seen store", () => {
  beforeEach(() => markRunning([], 0));

  it("records now the first time an id is seen", () => {
    markRunning(["a"], 100);
    expect(startedAt("a")).toBe(100);
    expect(startedAt("b")).toBeUndefined();
  });

  it("keeps the time while the id stays running", () => {
    markRunning(["a"], 100);
    markRunning(["a", "b"], 200);
    expect(startedAt("a")).toBe(100);
    expect(startedAt("b")).toBe(200);
  });

  it("resets when the id leaves running and enters it again", () => {
    markRunning(["a"], 100);
    markRunning([], 150);
    expect(startedAt("a")).toBeUndefined();
    markRunning(["a"], 300);
    expect(startedAt("a")).toBe(300);
  });
});
