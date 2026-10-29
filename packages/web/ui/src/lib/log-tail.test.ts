import { describe, expect, it } from "vitest";
import { currentStep, steeredCount, tailLines } from "./log-tail.js";

describe("log-tail", () => {
  it("finds the last step header", () => {
    expect(currentStep("### Planner\nx\n### Developer (fix round 1, reviewer)\ny")).toBe(
      "Developer (fix round 1, reviewer)",
    );
    expect(currentStep("no headers")).toBeNull();
  });

  it("counts steered blocks", () => {
    expect(steeredCount("### Steered\na\n### Developer\n### Steered\n")).toBe(2);
    expect(steeredCount("### Steered later")).toBe(0);
  });

  it("returns the last non-empty lines, right-trimmed", () => {
    expect(tailLines("a\n\nb\n  \nc\n", 2)).toEqual(["b", "c"]);
    expect(tailLines("a  \nb", 5)).toEqual(["a", "b"]);
    expect(tailLines("", 3)).toEqual([]);
  });
});
