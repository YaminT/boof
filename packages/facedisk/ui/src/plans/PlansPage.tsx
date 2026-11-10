import { useState } from "react";
import { api, ApiError, type PlanSummary } from "../api.js";
import { Button } from "@/ui/button";
import { FocusToggle } from "@/ui/focus-toggle";
import { useFocusMode } from "../lib/useFocusMode.js";
import { act } from "../lib/act.js";
import { planStatusTone } from "../lib/plan-view.js";
import { formatRoute, type Route } from "../lib/route.js";
import { relativeTime } from "../lib/time.js";
import { TonePill } from "../shell/StatusPill.js";
import type { AppData } from "../useAppData.js";
import { ImportResultDialog, NewPlanDialog } from "./PlanDialogs.js";
import { ProgressBar } from "./ProgressBar.js";

function PlanRow({ pid, plan }: { pid: string; plan: PlanSummary }) {
  const percent = plan.goalCount ? Math.round((100 * plan.doneCount) / plan.goalCount) : 0;
  return (
    <li className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-1 py-1.5 text-[length:var(--text-row)] last:border-b-0">
      <a
        href={formatRoute({ name: "plans", pid, planId: plan.id })}
        className="min-w-[8rem] flex-1 truncate font-medium text-ink no-underline hover:underline"
      >
        {plan.title}
      </a>
      <TonePill tone={planStatusTone(plan.status)}>{plan.status}</TonePill>
      <span className="flex items-center gap-2 text-ink-muted">
        <span className="tabular-nums">
          {plan.doneCount} of {plan.goalCount} done
        </span>
        <ProgressBar percent={percent} label={`${plan.title}: goals done`} />
      </span>
      {plan.autoSync && <span className="text-ink-muted">Auto-sync</span>}
      <span className="ml-auto text-[length:var(--text-meta)] text-ink-muted">
        {relativeTime(plan.updated)}
      </span>
    </li>
  );
}

/** The plans of a project, with "New plan" and "Import from repo". */
export function PlansPage({
  pid,
  data,
  navigate,
}: {
  pid: string;
  data: AppData;
  navigate: (to: Route) => void;
}) {
  const focus = useFocusMode("plans");
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [imported, setImported] = useState<{ lines: string[]; exists?: boolean } | null>(null);
  const active = data.plans.filter((p) => p.status !== "archived");
  const archived = data.plans.filter((p) => p.status === "archived");

  const runImport = async (merge: boolean) => {
    const report = await act(() => api.importPlan(pid, merge ? { merge: true } : {}), {
      failure: "Could not import",
      onError: (e) => {
        if (e instanceof ApiError && e.code === "plan_exists") {
          setImported({ lines: [e.message], exists: true });
          return true;
        }
        return false;
      },
    });
    if (!report) return;
    setImported({
      lines: [
        `Imported “${report.plan.title}”: ${report.added.length} added, ${report.updated.length} updated, ${report.unchanged.length} unchanged.`,
        ...report.warnings,
      ],
    });
    void data.refresh();
  };

  return (
    <div className="flex max-w-[1320px] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setCreating(true)}>New plan</Button>
        <Button variant="outline" onClick={() => void runImport(false)}>
          Import from repo
        </Button>
        <FocusToggle mode={focus.mode} onToggle={focus.toggle} className="ml-auto" />
      </div>
      {data.plansError && data.plans.length === 0 ? (
        <div className="py-6">
          <p className="mt-0 mb-3 text-ink-muted">Could not load plans.</p>
          <Button variant="outline" onClick={() => void data.refresh()}>
            Try again
          </Button>
        </div>
      ) : data.plans.length === 0 ? (
        <p className="m-0 py-6 text-ink-muted">
          No plans yet. Create one, or import plan.boof.xml from the repo.
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {active.map((p) => (
            <PlanRow key={p.id} pid={pid} plan={p} />
          ))}
        </ul>
      )}
      {archived.length > 0 && (
        <section className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-[length:var(--text-row)] text-ink-muted">
            Archived ({archived.length})
            {!focus.expanded && (
              <Button
                size="xs"
                variant="ghost"
                aria-expanded={showArchived}
                onClick={() => setShowArchived((s) => !s)}
              >
                {showArchived ? "Hide" : "Show"}
              </Button>
            )}
          </div>
          {(showArchived || focus.expanded) && (
            <ul className="m-0 list-none p-0">
              {archived.map((p) => (
                <PlanRow key={p.id} pid={pid} plan={p} />
              ))}
            </ul>
          )}
        </section>
      )}
      <NewPlanDialog
        open={creating}
        onOpenChange={setCreating}
        onCreate={async (input) => {
          const plan = await act(() => api.createPlan(pid, input), {
            failure: "Could not create the plan",
          });
          if (!plan) return;
          setCreating(false);
          void data.refresh();
          navigate({ name: "plans", pid, planId: plan.id });
        }}
      />
      <ImportResultDialog
        result={imported}
        onClose={() => setImported(null)}
        onMerge={() => {
          setImported(null);
          void runImport(true);
        }}
      />
    </div>
  );
}
