import { describe, expect, it } from "vitest";
import type { BudgetScope, BudgetStatus } from "../api-types.js";
import { spendFor } from "./spend.js";

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
