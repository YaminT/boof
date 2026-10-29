import { beforeEach, describe, expect, it } from "vitest";
import { markRunning, startedAt } from "./first-seen";

describe("first-seen store", () => {
  beforeEach(() => {
    markRunning("p", [], 0);
    markRunning("q", [], 0);
  });

  it("records now the first time an id is seen", () => {
    markRunning("p", ["a"], 100);
    expect(startedAt("p", "a")).toBe(100);
    expect(startedAt("p", "b")).toBeUndefined();
  });

  it("keeps the time while the id stays running", () => {
    markRunning("p", ["a"], 100);
    markRunning("p", ["a", "b"], 200);
    expect(startedAt("p", "a")).toBe(100);
    expect(startedAt("p", "b")).toBe(200);
  });

  it("resets when the id leaves running and enters it again", () => {
    markRunning("p", ["a"], 100);
    markRunning("p", [], 150);
    expect(startedAt("p", "a")).toBeUndefined();
    markRunning("p", ["a"], 300);
    expect(startedAt("p", "a")).toBe(300);
  });

  it("keeps a project's clocks while another project is marked", () => {
    markRunning("p", ["a"], 100);
    markRunning("q", [], 150);
    markRunning("q", ["a"], 160);
    expect(startedAt("p", "a")).toBe(100);
    expect(startedAt("q", "a")).toBe(160);
    markRunning("p", ["a"], 500);
    expect(startedAt("p", "a")).toBe(100);
  });
});
