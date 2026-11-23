import { useState } from "react";
import { Button } from "../ui/button.js";
import type { HarnessesState } from "../useHarnesses.js";
import { compactSummary, needsAttention } from "../lib/doctor.js";
import { useConnection } from "../lib/useConnection.js";
import { formatRoute } from "../lib/route.js";
import { CheckRows, LINK } from "./CheckRows.js";

const CONNECTION_WORD = {
  reconnecting: "Checking…",
  offline: "Offline",
  "signed-out": "Sign in needed",
} as const;

/**
 * The Doctor widget on the first page: always shown, never blocking. One line when everything
 * passes (with a toggle for the rows); open by itself when something needs attention. It reads the
 * shared harness state, so it adds no request of its own.
 */
export function SetupCheckWidget({
  harnesses,
  pid,
}: {
  harnesses: HarnessesState;
  pid: string | null;
}) {
  const { status, loading, failed, denied, refresh } = harnesses;
  const { state: conn } = useConnection();
  const [chosen, setChosen] = useState<boolean | null>(null);
  const attention = status ? needsAttention(status) : false;
  const open = chosen ?? attention;
  return (
    <section
      aria-label="Doctor"
      data-testid="setup-check"
      data-state={open ? "expanded" : "compact"}
      className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-3 text-[length:var(--text-row)]"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="m-0 text-[length:var(--text-body)] font-semibold">Doctor</h2>
        <span
          data-testid="setup-check-summary"
          className={`min-w-[8rem] flex-1 ${attention ? "text-attention" : "text-ink-muted"}`}
        >
          {denied
            ? "This key cannot read the Doctor."
            : status
              ? attention
                ? "Needs attention"
                : compactSummary(status)
              : failed && conn !== "live"
                ? CONNECTION_WORD[conn]
                : failed
                  ? "Could not run the checks."
                  : loading
                    ? "Checking this computer…"
                    : ""}
        </span>
        {status && (
          <Button variant="outline" size="sm" aria-expanded={open} onClick={() => setChosen(!open)}>
            {open ? "Hide details" : "Show details"}
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={loading} onClick={refresh}>
          Check again
        </Button>
        <a href={formatRoute({ name: "doctor" })} className={LINK}>
          Open full check
        </a>
      </div>
      {status && open && <CheckRows checks={status.checks} pid={pid} />}
    </section>
  );
}
