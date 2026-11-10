import { describe, expect, it } from "vitest";
import {
  accountActionAccess,
  accountAgentBadges,
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

describe("Agent SDK badges", () => {
  const accounts = [
    { id: "a", name: "console" },
    { id: "b", name: "max" },
    { id: "c", name: "token" },
    { id: "d", name: "odd" },
  ];
  const eligibility = {
    gateway: "checked" as const,
    allowed: false,
    reason: "the better-ccflare gateway would route to max (subscription)",
    blocking: [
      { id: "b", name: "max", provider: "anthropic", why: "subscription" as const },
      { id: "c", name: "token", provider: "anthropic", why: "oauth-token" as const },
      { id: "d", name: "odd", provider: null, why: "unknown-type" as const },
    ],
    checkedAt: "2026-11-05T10:00:00Z",
  };

  it("maps blocking accounts to a not-allowed badge with the reason", () => {
    expect(accountAgentBadges(accounts, eligibility)).toEqual({
      a: { allowed: true, text: "Agent SDK: allowed" },
      b: { allowed: false, text: "Agent SDK: not allowed (subscription)" },
      c: { allowed: false, text: "Agent SDK: not allowed (OAuth token)" },
      d: { allowed: false, text: "Agent SDK: not allowed (unknown type)" },
    });
  });

  it("shows no badge before the eligibility is known, without a gateway, or when the gate is closed with nothing to blame", () => {
    expect(accountAgentBadges(accounts, null).a).toBeNull();
    expect(accountAgentBadges(accounts, { ...eligibility, gateway: "absent" }).a).toBeNull();
    expect(accountAgentBadges(accounts, { ...eligibility, blocking: [] }).a).toBeNull();
    expect(
      accountAgentBadges(accounts, { ...eligibility, allowed: true, blocking: [] }).a?.allowed,
    ).toBe(true);
  });
});
