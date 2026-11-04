import { describe, expect, it } from "vitest";
import { formatTime } from "./format-time.js";

describe("formatTime", () => {
  it("treats numeric values below 1e12 as seconds", () => {
    expect(formatTime(1_767_225_600)).toContain(new Date(1_767_225_600_000).toLocaleString());
  });

  it("treats numeric values at or above 1e12 as milliseconds", () => {
    expect(formatTime(1_767_225_600_000)).toContain(new Date(1_767_225_600_000).toLocaleString());
  });
});
