import type { BudgetStatus } from "../api-types.js";
import { spendFor } from "../lib/spend.js";

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Today's spend against the limit, if any; hidden when the budget is unknown. */
export function SpendBar({ budget, pid }: { budget: BudgetStatus | null; pid: string }) {
  const spend = spendFor(budget, pid);
  if (!spend) return null;
  const f = spend.fraction;
  const tone = spend.exceeded
    ? "bg-failed"
    : f !== null && f >= 0.8
      ? "bg-attention"
      : "bg-accent-brand";
  return (
    <div className="flex flex-wrap items-center gap-3 text-[length:var(--text-row)]">
      <span>
        {spend.limitUsd === null
          ? `Spend today ${usd(spend.spentUsd)} (no limit)`
          : `Spend today ${usd(spend.spentUsd)} of ${usd(spend.limitUsd)}`}
      </span>
      {f !== null && (
        <div
          role="progressbar"
          aria-label="Spend today"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(f * 100)}
          className="h-1 w-48 overflow-hidden rounded-full bg-line"
        >
          <div className={`h-full ${tone}`} style={{ width: `${f * 100}%` }} />
        </div>
      )}
    </div>
  );
}
