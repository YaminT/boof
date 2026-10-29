import { describe, expect, it } from "vitest";
import { relativeTime } from "./time";

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
