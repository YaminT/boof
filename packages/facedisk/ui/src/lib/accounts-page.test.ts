import { describe, expect, it } from "vitest";
import {
  accountActionAccess,
  gatePauses,
  priorityProblem,
  thresholdFields,
} from "./accounts-page.js";

describe("accounts page helpers", () => {
  it("requires a trusted, project-unrestricted key with settings:write for shared pool actions", () => {
    expect(accountActionAccess("all")).toBe(true);
    expect(accountActionAccess(new Set(["settings:write"]))).toBe(true);
    expect(accountActionAccess(new Set(["settings:read"]))).toBe(false);
    expect(accountActionAccess(new Set(["settings:write"]), "review", "*")).toBe(false);
    expect(accountActionAccess(new Set(["settings:write"]), "trusted", ["project-a"])).toBe(false);
    expect(accountActionAccess(new Set(["settings:write"]), "trusted", ["repo"])).toBe(false);
    expect(accountActionAccess(new Set(["settings:write"]), "trusted", "*")).toBe(true);
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

  it("requires a non-empty whole priority from 0 to 100", () => {
    expect(priorityProblem("")).toBe("Enter a whole priority from 0 to 100.");
    expect(priorityProblem("2.5")).not.toBeNull();
    expect(priorityProblem("150")).not.toBeNull();
    expect(priorityProblem("42")).toBeNull();
  });
});
