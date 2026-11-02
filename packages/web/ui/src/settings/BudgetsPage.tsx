import { useEffect, useState } from "react";
import type { Project, TokenUsage } from "@boof-runner/shared/schema";
import { api } from "../api.js";
import type { BudgetStatus } from "../api-types.js";
import { Input } from "@/ui/input";
import { NativeSelect } from "@/ui/native-select";
import { Textarea } from "@/ui/textarea";
import { scopeLabel, todayScopes, usageText } from "../lib/spend.js";
import type { BudgetsValues } from "../lib/settings-budgets.js";
import { OverrideHeader, OverrideRow } from "./OverrideRow.js";

const h2 = "m-0 text-[length:var(--text-section)] font-semibold";
const usd = (n: number) => `$${n.toFixed(2)}`;

function SpendRow({ scope }: { scope: BudgetStatus["scopes"][number] }) {
  const { spentUsd, limitUsd, exceeded } = scope;
  const f = limitUsd ? spentUsd / limitUsd : null;
  const pct = f === null ? 0 : Math.min(100, Math.max(0, Math.round(f * 100)));
  const tone = exceeded ? "bg-failed" : f !== null && f >= 0.8 ? "bg-attention" : "bg-accent-brand";
  const label = scopeLabel(scope.scope);
  return (
    <div className="flex flex-col gap-1 py-1.5 text-[length:var(--text-row)]">
      <div className="flex justify-between gap-3">
        <span>{label}</span>
        <span className="tabular-nums">
          {limitUsd !== null
            ? `${usd(spentUsd)} of ${usd(limitUsd)}`
            : `${usd(spentUsd)} (no limit)`}
        </span>
      </div>
      {f !== null && (
        <div
          role="progressbar"
          aria-label={`${label} spend today`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="h-1 w-full overflow-hidden rounded-full bg-line"
        >
          <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/** Settings › Budgets: today's spend, token usage, and the limits for all projects and this one. */
export function BudgetsPage({
  form,
  set,
  project,
  budget,
}: {
  form: BudgetsValues;
  set: (update: (v: BudgetsValues) => BudgetsValues) => void;
  project: Project;
  budget: BudgetStatus | null;
}) {
  const g = form.global;
  const o = form.project;
  const setG = (patch: Partial<BudgetsValues["global"]>) =>
    set((v) => ({ ...v, global: { ...v.global, ...patch } }));
  const setO = (patch: Partial<BudgetsValues["project"]>) =>
    set((v) => ({ ...v, project: { ...v.project, ...patch } }));

  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [projectUsage, setProjectUsage] = useState<TokenUsage | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .usage()
      .then((u) => !cancelled && setUsage(u))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setProjectUsage(null);
    void api
      .projectUsage(project.id)
      .then((u) => !cancelled && setProjectUsage(u))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const usdInput = (
    value: string,
    onChange: (v: string) => void,
    label: string,
    placeholder: string,
  ) => (
    <Input
      aria-label={label}
      inputMode="decimal"
      className="mt-0 font-normal"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
  const toolBox = (
    value: string,
    onChange: (v: string) => void,
    label: string,
    placeholder: string,
  ) => (
    <Textarea
      aria-label={label}
      rows={2}
      className="plain-font mt-0 font-mono font-normal"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
  const none = (
    <span className="text-[length:var(--text-row)] text-ink-muted">Not set per project.</span>
  );

  return (
    <div className="flex max-w-[1000px] flex-col gap-8">
      <section className="flex flex-col gap-2">
        <h2 className={h2}>Today</h2>
        {!budget ? (
          <p className="m-0 text-[length:var(--text-row)] text-ink-muted">Loading…</p>
        ) : (
          <>
            <p className="m-0 text-[length:var(--text-row)] text-ink-muted">
              Today, {budget.date} ({budget.timezone}). Resets{" "}
              {new Date(budget.resetsAt).toLocaleTimeString()}.
            </p>
            <div className="flex max-w-[640px] flex-col">
              {todayScopes(budget, project.id).map((s) => (
                <SpendRow key={s.scope} scope={s} />
              ))}
            </div>
            {budget.unknownSteps > 0 && (
              <p className="m-0 text-[length:var(--text-row)] text-ink-muted">
                {budget.unknownSteps} step{budget.unknownSteps === 1 ? "" : "s"} reported no cost
                and count as $0.
              </p>
            )}
          </>
        )}
        <p className="m-0 mt-2 text-[length:var(--text-row)]">
          <strong>{project.name}:</strong> {usageText(projectUsage)}
        </p>
        <p className="m-0 text-[length:var(--text-row)]">
          <strong>All projects:</strong> {usageText(usage)}
        </p>
      </section>

      <section className="flex flex-col">
        <h2 className={h2}>Limits</h2>
        <p className="m-0 mb-3 max-w-[80ch] text-[length:var(--text-row)] text-ink-muted">
          Limits in USD; leave a field empty for no limit. A running step is never stopped: limits
          are checked between steps, so a step can go over. Day limits block new work until the day
          resets.
        </p>
        <OverrideHeader projectName={project.name} />
        <OverrideRow
          label="Per task"
          inherit={false}
          onInherit={() => {}}
          inheritedText=""
          showChoice={false}
          global={usdInput(
            g.perTask,
            (v) => setG({ perTask: v }),
            "Per task, all projects",
            "No limit",
          )}
          override={usdInput(
            o.perTask,
            (v) => setO({ perTask: v }),
            "Per task, this project",
            "Same as all projects",
          )}
        />
        <OverrideRow
          label="Per day, all work"
          inherit
          onInherit={() => {}}
          inheritedText=""
          showChoice={false}
          global={usdInput(g.perDay, (v) => setG({ perDay: v }), "Per day, all work", "No limit")}
          override={none}
        />
        <OverrideRow
          label="Per day, each project"
          inherit={false}
          onInherit={() => {}}
          inheritedText=""
          showChoice={false}
          global={usdInput(
            g.perProjectDay,
            (v) => setG({ perProjectDay: v }),
            "Per day, each project",
            "No limit",
          )}
          override={usdInput(
            o.perDay,
            (v) => setO({ perDay: v }),
            "Per day, this project",
            "Same as all projects",
          )}
        />
        <OverrideRow
          label="Per day, each tool"
          inherit={false}
          onInherit={() => {}}
          inheritedText=""
          showChoice={false}
          global={toolBox(
            g.perTool,
            (v) => setG({ perTool: v }),
            "Per day, each tool, all projects",
            "codex=5",
          )}
          override={toolBox(
            o.perTool,
            (v) => setO({ perTool: v }),
            "Per day, each tool, this project",
            "codex=5",
          )}
        />
        <OverrideRow
          label="When a limit is spent"
          inherit={false}
          onInherit={() => {}}
          inheritedText=""
          showChoice={false}
          global={
            <NativeSelect
              aria-label="When a limit is spent"
              className="w-full"
              value={g.onExceed}
              onChange={(e) => setG({ onExceed: e.target.value as typeof g.onExceed })}
            >
              <option value="pause">Fail the task, keep its worktree (pause)</option>
              <option value="fail">Fail the task, follow the worktree failure setting</option>
            </NativeSelect>
          }
          override={
            <NativeSelect
              aria-label="When a limit is spent, this project"
              className="w-full"
              value={o.onExceed}
              onChange={(e) => setO({ onExceed: e.target.value as typeof o.onExceed })}
            >
              <option value="">Same as all projects</option>
              <option value="pause">Fail the task, keep its worktree (pause)</option>
              <option value="fail">Fail the task, follow the worktree failure setting</option>
            </NativeSelect>
          }
        />
        <OverrideRow
          label="Time zone"
          inherit
          onInherit={() => {}}
          inheritedText=""
          showChoice={false}
          global={
            <>
              <Input
                aria-label="Time zone"
                className="mt-0 font-mono font-normal"
                value={g.timezone}
                placeholder="e.g. Europe/Berlin"
                onChange={(e) => setG({ timezone: e.target.value })}
              />
              <span className="text-[length:var(--text-meta)] text-ink-muted">
                IANA name; empty uses the server&apos;s zone.
              </span>
            </>
          }
          override={none}
        />
      </section>
    </div>
  );
}
