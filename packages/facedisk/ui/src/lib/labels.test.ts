import { describe, expect, it } from "vitest";
import { runningLabel, unorderedMarker } from "./labels.js";

describe("runningLabel", () => {
  it("prefers the title, falls back to the id, never empty", () => {
    expect(runningLabel("Build it", "t1")).toBe("Build it");
    expect(runningLabel("", "t1")).toBe("t1");
    expect(runningLabel("  ", "t1")).toBe("t1");
    expect(runningLabel(null, "t1")).toBe("t1");
    expect(runningLabel(null, undefined)).toBeNull();
  });
});

describe("unorderedMarker", () => {
  it("labels blocked tasks waiting, not skipped", () => {
    expect(unorderedMarker(["blocked"])).toBe("waiting");
    expect(unorderedMarker([])).toBe("skipped");
  });
});
