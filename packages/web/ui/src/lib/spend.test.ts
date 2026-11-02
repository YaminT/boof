import { describe, expect, it } from "vitest";
import type { BudgetScope, BudgetStatus } from "../api-types.js";
import { scopeLabel, spendFor, todayScopes, usageText } from "./spend.js";

const scope = (
  s: string,
  spentUsd: number,
  limitUsd: number | null,
  exceeded = false,
): BudgetScope => ({
  scope: s,
  spentUsd,
  limitUsd,
  remainingUsd: limitUsd === null ? null : limitUsd - spentUsd,
  exceeded,
});
const budget = (scopes: BudgetScope[]): BudgetStatus => ({
  date: "2026-10-27",
  timezone: "UTC",
  resetsAt: "2026-10-28T00:00:00Z",
  unknownSteps: 0,
  scopes,
  exceeded: [],
});

describe("spendFor", () => {
  it("returns null without a budget or matching scope", () => {
    expect(spendFor(null, "a")).toBeNull();
    expect(spendFor(budget([]), "a")).toBeNull();
    expect(spendFor(budget([scope("tool:codex", 1, 2)]), null)).toBeNull();
  });

  it("prefers the project scope, else global", () => {
    const b = budget([scope("global", 5, 10), scope("project:a", 1, 4)]);
    expect(spendFor(b, "a")?.scope).toBe("project:a");
    expect(spendFor(b, "z")?.scope).toBe("global");
    expect(spendFor(b, null)?.scope).toBe("global");
  });

  it("computes a clamped fraction", () => {
    expect(spendFor(budget([scope("global", 5, 10)]), null)?.fraction).toBe(0.5);
    expect(spendFor(budget([scope("global", 15, 10, true)]), null)).toMatchObject({
      fraction: 1,
      exceeded: true,
    });
    expect(spendFor(budget([scope("global", 3, null)]), null)).toMatchObject({
      spentUsd: 3,
      limitUsd: null,
      fraction: null,
    });
  });
});

describe("scopeLabel", () => {
  it("names scopes for people", () => {
    expect(scopeLabel("global")).toBe("All work");
    expect(scopeLabel("tool:codex")).toBe("tool codex");
    expect(
      scopeLabel("project:alpha/tool:codex", (id) => (id === "alpha" ? "Alpha" : undefined)),
    ).toBe("Project Alpha, tool codex");
    expect(scopeLabel("project:zed")).toBe("Project zed");
  });
});

describe("todayScopes", () => {
  it("keeps all work, this project and its tools, and tools with a limit or spend", () => {
    const b = budget([
      scope("global", 1, 10),
      scope("project:alpha", 1, null),
      scope("project:alpha/tool:codex", 1, null),
      scope("project:beta", 1, null),
      scope("tool:codex", 1, null),
      scope("tool:opencode", 0, null),
      scope("tool:claude-code", 0, 5),
    ]);
    expect(todayScopes(b, "alpha").map((s) => s.scope)).toEqual([
      "global",
      "project:alpha",
      "project:alpha/tool:codex",
      "tool:codex",
      "tool:claude-code",
    ]);
  });
});

describe("usageText", () => {
  it("reads as a sentence", () => {
    expect(usageText(null)).toBe("Loading…");
    expect(
      usageText({ inputTokens: 1234, outputTokens: 567, costUsd: 0.1234, known: true } as never),
    ).toBe("1,234 input tokens, 567 output tokens, $0.1234");
    expect(usageText({ inputTokens: 5, outputTokens: 6, costUsd: 0, known: false } as never)).toBe(
      "5 input tokens, 6 output tokens, cost unknown",
    );
  });
});
