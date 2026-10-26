import type { BudgetScope, BudgetStatus } from "../api-types.js";

const usd = (n: number) => `$${n.toFixed(2)}`;

function scopeLabel(scope: string): string {
  if (scope === "global") return "All work";
  return scope
    .split("/")
    .map((part) =>
      part.startsWith("project:")
        ? `project ${part.slice(8)}`
        : part.startsWith("tool:")
          ? `tool ${part.slice(5)}`
          : part,
    )
    .join(", ");
}

/** Shown above the page while a day budget keeps the runner from starting work. */
export function BudgetBanner({ budget }: { budget: BudgetStatus }) {
  if (budget.exceeded.length === 0) return null;
  const resumes = new Date(budget.resetsAt).toLocaleString();
  return (
    <div className="budget-banner" role="status">
      <strong>Budget spent.</strong>{" "}
      {budget.exceeded
        .map((s) => `${scopeLabel(s.scope)}: ${usd(s.spentUsd)} of ${usd(s.limitUsd ?? 0)}`)
        .join(" · ")}
      . The runner starts no work in {budget.exceeded.length === 1 ? "this scope" : "these scopes"}{" "}
      until the budget resets on {resumes} ({budget.timezone}).
    </div>
  );
}

/** One spend line: label, amount against the limit, and a bar when a limit exists. */
export function SpendBar({ scope }: { scope: BudgetScope }) {
  const { spentUsd, limitUsd, exceeded } = scope;
  const pct = limitUsd ? Math.min(100, (spentUsd / limitUsd) * 100) : 0;
  return (
    <div className={`spend${exceeded ? " over" : ""}`}>
      <div className="spend-row">
        <span>{scopeLabel(scope.scope)}</span>
        <span>
          {usd(spentUsd)}
          {limitUsd !== null ? ` of ${usd(limitUsd)}` : " (no limit)"}
        </span>
      </div>
      {limitUsd !== null && (
        <div
          className="spend-bar"
          role="progressbar"
          aria-label={`${scopeLabel(scope.scope)} spend today`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
        >
          <div className="spend-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/** Today's spend for the global scope, the tools and one project (limits first). */
export function TodaySpend({
  budget,
  projectId,
}: {
  budget: BudgetStatus | null;
  projectId: string;
}) {
  if (!budget) return <p className="muted">Loading…</p>;
  const shown = budget.scopes.filter(
    (s) =>
      s.scope === "global" ||
      s.scope === `project:${projectId}` ||
      s.scope.startsWith(`project:${projectId}/`) ||
      (s.scope.startsWith("tool:") && (s.limitUsd !== null || s.spentUsd > 0)),
  );
  return (
    <>
      <p className="muted">
        Today ({budget.date}, {budget.timezone}); resets{" "}
        {new Date(budget.resetsAt).toLocaleString()}.
      </p>
      {shown.map((s) => (
        <SpendBar key={s.scope} scope={s} />
      ))}
      {budget.unknownSteps > 0 && (
        <p className="muted">
          {budget.unknownSteps} step{budget.unknownSteps === 1 ? "" : "s"} reported no cost and
          count as $0.
        </p>
      )}
    </>
  );
}
