import { describe, expect, it } from "vitest";
import { dayStart } from "./admin.js";

describe("dayStart", () => {
  const now = Date.parse("2026-11-16T23:30:00Z");
  it("uses the caller's UTC offset (Date.getTimezoneOffset)", () => {
    // UTC+2 (offset -120): 01:30 on the 17th there, so today began at 22:00Z on the 16th.
    expect(dayStart(now, -120)).toBe(Date.parse("2026-11-16T22:00:00Z"));
    // UTC-5 (offset 300): 18:30 on the 16th there, so today began at 05:00Z on the 16th.
    expect(dayStart(now, 300)).toBe(Date.parse("2026-11-16T05:00:00Z"));
    expect(dayStart(now, 0)).toBe(Date.parse("2026-11-16T00:00:00Z"));
  });
  it("falls back to the server's local midnight", () => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    expect(dayStart(now)).toBe(d.getTime());
  });
});
