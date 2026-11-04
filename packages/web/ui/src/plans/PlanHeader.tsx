import { EllipsisIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Plan } from "../api.js";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { formatRoute } from "../lib/route.js";
import { planProgress, planStatusTone } from "../lib/plan-view.js";
import { TonePill } from "../shell/StatusPill.js";
import { ProgressBar } from "./ProgressBar.js";

/** Title, status, progress and the plan's actions: one primary button, the rest in the overflow. */
export function PlanHeader({
  pid,
  plan,
  busy,
  onActivate,
  onSync,
  onAddGoal,
  onAutoSync,
  onBumpTo,
  onExport,
  onArchive,
  focusToggle,
}: {
  pid: string;
  plan: Plan;
  busy: boolean;
  onActivate: () => void;
  onSync: () => void;
  onAddGoal: () => void;
  onAutoSync: (on: boolean) => void;
  onBumpTo: (v: "review" | "done") => void;
  onExport: () => void;
  onArchive: () => void;
  focusToggle?: ReactNode;
}) {
  const p = planProgress(plan.goals);
  return (
    <header className="mb-4 flex flex-col gap-2">
      <a href={formatRoute({ name: "plans", pid })} className="text-[length:var(--text-row)]">
        ← Plans
      </a>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 min-w-0 text-[length:var(--text-page)] leading-tight font-semibold">
          {plan.title}
        </h1>
        <TonePill tone={planStatusTone(plan.status)}>{plan.status}</TonePill>
        <span className="ml-auto flex items-center gap-2">
          {focusToggle}
          {plan.status === "draft" && (
            <Button onClick={onActivate} disabled={busy}>
              Activate plan
            </Button>
          )}
          {plan.status === "active" && (
            <Button onClick={onSync} disabled={busy}>
              Sync
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="More actions for this plan"
              className="inline-flex size-8 items-center justify-center rounded-md text-ink-muted outline-none hover:bg-accent hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <EllipsisIcon className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onClick={onAddGoal}>Add goal</DropdownMenuItem>
              <DropdownMenuCheckboxItem
                checked={plan.autoSync}
                onCheckedChange={onAutoSync}
                closeOnClick
              >
                Auto-sync
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Bump finished goals to</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={plan.bumpTo}
                  onValueChange={(v) => onBumpTo(v as "review" | "done")}
                >
                  <DropdownMenuRadioItem value="review" closeOnClick>
                    Review
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="done" closeOnClick>
                    Done
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onExport}>Export XML</DropdownMenuItem>
              {plan.status !== "archived" && (
                <DropdownMenuItem onClick={onArchive}>Archive plan…</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      <div className="flex items-center gap-3 text-[length:var(--text-row)] text-ink-muted">
        <span>
          {p.total} {p.total === 1 ? "goal" : "goals"}, {p.done} done
        </span>
        {p.percent !== null && <ProgressBar percent={p.percent} label="Goals done" />}
      </div>
      {plan.description && (
        <p className="m-0 max-w-[80ch] text-[length:var(--text-body)] text-ink-muted">
          {plan.description}
        </p>
      )}
    </header>
  );
}
