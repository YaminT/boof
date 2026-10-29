import { describe, expect, it } from "vitest";
import { formatElapsed, relativeTime } from "./time";

describe("formatElapsed", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59)).toBe("59s");
    expect(formatElapsed(252)).toBe("4m 12s");
    expect(formatElapsed(3840)).toBe("1h 4m");
    expect(formatElapsed(-5)).toBe("0s");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  it("rounds down to the largest unit", () => {
    expect(relativeTime("2026-10-29T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-10-29T11:55:00Z", now)).toBe("5m ago");
    expect(relativeTime("2026-10-29T10:00:00Z", now)).toBe("2h ago");
    expect(relativeTime("2026-10-26T12:00:00Z", now)).toBe("3d ago");
  });
  it("returns an empty string for a bad date", () => {
    expect(relativeTime("nope", now)).toBe("");
  });
});
