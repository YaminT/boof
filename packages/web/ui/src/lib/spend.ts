import type { BudgetStatus } from "../api-types.js";

export interface Spend {
  scope: string;
  spentUsd: number;
  limitUsd: number | null;
  fraction: number | null;
  exceeded: boolean;
}

/** Spend for a project (its `project:<id>` scope) or else the `global` scope. */
export function spendFor(budget: BudgetStatus | null, projectId: string | null): Spend | null {
  if (!budget) return null;
  const scope =
    (projectId !== null && budget.scopes.find((s) => s.scope === `project:${projectId}`)) ||
    budget.scopes.find((s) => s.scope === "global");
  if (!scope) return null;
  const fraction =
    scope.limitUsd === null || scope.limitUsd <= 0
      ? null
      : Math.min(1, Math.max(0, scope.spentUsd / scope.limitUsd));
  return {
    scope: scope.scope,
    spentUsd: scope.spentUsd,
    limitUsd: scope.limitUsd,
    fraction,
    exceeded: scope.exceeded,
  };
}
