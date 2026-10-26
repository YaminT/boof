import {
  appendEvent,
  markBudgetNotified,
  type BudgetScope,
  type BudgetStatus,
} from "@boof-runner/shared";

/**
 * Record a `runner.budget_exceeded` event the first time `scope` is seen spent on this day
 * (the marker lives in the global daily ledger, so a restart does not repeat it). Never throws.
 */
export async function announceBudgetExceeded(
  dataRoot: string,
  status: BudgetStatus,
  scope: BudgetScope,
  projectId?: string,
): Promise<void> {
  if (scope.limitUsd === null) return;
  try {
    const first = await markBudgetNotified(dataRoot, status.date, status.timezone, scope.scope);
    if (!first) return;
    const project = scope.scope.startsWith("project:")
      ? scope.scope.slice("project:".length).split("/")[0]
      : projectId;
    await appendEvent(dataRoot, {
      type: "runner.budget_exceeded",
      scope: scope.scope,
      date: status.date,
      spentUsd: scope.spentUsd,
      limitUsd: scope.limitUsd,
      ...(scope.scope.startsWith("project:") && project ? { project } : {}),
      by: "runner",
    });
  } catch (err) {
    console.error("could not record the budget event:", err);
  }
}
