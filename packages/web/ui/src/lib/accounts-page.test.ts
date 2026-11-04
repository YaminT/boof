import { describe, expect, it } from "vitest";
import { accountActionAccess, gatePauses, thresholdFields } from "./accounts-page.js";

describe("accounts page helpers", () => {
  it("shows account actions only to a key with settings:write", () => {
    expect(accountActionAccess("all")).toBe(true);
    expect(accountActionAccess(new Set(["settings:write"]))).toBe(true);
    expect(accountActionAccess(new Set(["settings:read"]))).toBe(false);
  });

  it("flags unhealthy pools when the gate pauses work", () => {
    expect(gatePauses("pause", "degraded")).toBe(true);
    expect(gatePauses("pause", "unreachable")).toBe(true);
    expect(gatePauses("warn", "degraded")).toBe(false);
    expect(gatePauses("pause", "ok")).toBe(false);
  });

  it("formats gateway thresholds without inventing values", () => {
    expect(thresholdFields({ fiveHour: 80, weekly: null, custom: 25 })).toEqual([
      ["fiveHour", "80"],
      ["weekly", ""],
      ["custom", "25"],
    ]);
  });
});
