import type { BudgetStatus } from "../api-types.js";
import { scopeLabel } from "../lib/spend.js";

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Shown above the page while a day budget keeps the runner from starting work. */
export function BudgetBanner({ budget }: { budget: BudgetStatus }) {
  if (budget.exceeded.length === 0) return null;
  const resumes = new Date(budget.resetsAt).toLocaleString();
  return (
    <div
      role="status"
      className="mb-4 rounded-md border border-attention/40 bg-surface px-3 py-2 text-[length:var(--text-row)] text-attention"
    >
      <strong>Budget spent.</strong>{" "}
      {budget.exceeded
        .map((s) => `${scopeLabel(s.scope)}: ${usd(s.spentUsd)} of ${usd(s.limitUsd ?? 0)}`)
        .join("; ")}
      . The runner starts no work in {budget.exceeded.length === 1 ? "this scope" : "these scopes"}{" "}
      until the budget resets on {resumes} ({budget.timezone}).
    </div>
  );
}
