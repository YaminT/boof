import { describe, expect, it } from "vitest";
import { currentStep, liveFollowKey, stepHeaders, tailLines } from "./log-tail.js";

describe("log-tail", () => {
  it("finds the last step header", () => {
    expect(currentStep("### Planner\nx\n### Developer (fix round 1, reviewer)\ny")).toBe(
      "Developer (fix round 1, reviewer)",
    );
    expect(currentStep("no headers")).toBeNull();
  });

  it("lists the step headers in order", () => {
    expect(stepHeaders("### Planner\nx\n### Developer\n#### no\n### Reviewer (round 1)")).toEqual([
      "Planner",
      "Developer",
      "Reviewer (round 1)",
    ]);
    expect(stepHeaders("none")).toEqual([]);
  });

  it("changes when a partial line grows without a newline", () => {
    const partial = "line one\nhel";
    const grown = "line one\nhello";
    expect(partial.split("\n").length).toBe(grown.split("\n").length);
    expect(liveFollowKey(partial)).not.toBe(liveFollowKey(grown));
    expect(liveFollowKey("done\n")).toBe(liveFollowKey("done"));
  });

  it("returns the last non-empty lines, right-trimmed", () => {
    expect(tailLines("a\n\nb\n  \nc\n", 2)).toEqual(["b", "c"]);
    expect(tailLines("a  \nb", 5)).toEqual(["a", "b"]);
    expect(tailLines("", 3)).toEqual([]);
  });
});
