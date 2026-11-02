import type { TokenUsage } from "@boof-runner/shared/schema";
import type { BudgetScope, BudgetStatus } from "../api-types.js";

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

/** A budget scope for people: "All work", "Project Alpha, tool codex". */
export function scopeLabel(scope: string, nameOf?: (id: string) => string | undefined): string {
  if (scope === "global") return "All work";
  return scope
    .split("/")
    .map((part) => {
      if (part.startsWith("project:")) {
        const id = part.slice(8);
        return `Project ${nameOf?.(id) ?? id}`;
      }
      if (part.startsWith("tool:")) return `tool ${part.slice(5)}`;
      return part;
    })
    .join(", ");
}

/** The scopes Today shows: all work, this project and its tools, and tools that matter. */
export function todayScopes(budget: BudgetStatus, pid: string): BudgetScope[] {
  return budget.scopes.filter(
    (s) =>
      s.scope === "global" ||
      s.scope === `project:${pid}` ||
      s.scope.startsWith(`project:${pid}/`) ||
      (s.scope.startsWith("tool:") && (s.limitUsd !== null || s.spentUsd > 0)),
  );
}

/** Token usage as a sentence; no middle dots. */
export function usageText(u: TokenUsage | null): string {
  if (!u) return "Loading…";
  const cost = u.known ? `$${u.costUsd.toFixed(4)}` : "cost unknown";
  return `${u.inputTokens.toLocaleString("en-US")} input tokens, ${u.outputTokens.toLocaleString("en-US")} output tokens, ${cost}`;
}

/** When the day's budget resets, for people: "at midnight (UTC)" or "at 06:00 (Europe/Berlin)". */
export function resetText(resetsAt: string, timezone: string): string {
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return "";
  let hm: string;
  try {
    hm = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    hm = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
  }
  return hm === "00:00" || hm === "24:00" ? `at midnight (${timezone})` : `at ${hm} (${timezone})`;
}
