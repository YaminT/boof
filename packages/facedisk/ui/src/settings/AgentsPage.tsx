import { useEffect, useMemo, useState } from "react";
import type { Project, RoleAssignment } from "@boof/heart/schema";
import { api } from "../api.js";
import type { HealthResult, ToolModelDetails } from "../api-types.js";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { NativeSelect } from "@/ui/native-select";
import {
  checkedAgo,
  roleModelLabel,
  ROLES,
  usageLabel,
  type AgentsValues,
  type RoleName,
} from "../lib/settings-agents.js";
import { AdvancedSection } from "./AdvancedSection.js";
import { TonePill } from "../shell/StatusPill.js";
import { AddModelDialog } from "./AddModelDialog.js";
import { OverrideHeader, OverrideRow } from "./OverrideRow.js";
import { RoleSelects } from "./RoleSelects.js";

const h2 = "m-0 text-[length:var(--text-section)] font-semibold";
const SOURCE: Record<string, { label: string; title: string }> = {
  cli: { label: "cli", title: "Reported by the tool's CLI" },
  default: { label: "built-in", title: "From the tool's built-in model list" },
  settings: { label: "added", title: "Added in Settings" },
};
const ON_DONE = [
  ["keep-branch", "Keep branch, remove directory"],
  ["keep", "Keep branch and directory"],
  ["delete", "Delete both"],
] as const;
const ON_FAILURE = [
  ["keep", "Keep branch and directory"],
  ["delete", "Delete both"],
] as const;

const countInput = (value: string, onChange: (v: string) => void, label: string, min: number) => (
  <Input
    aria-label={label}
    type="number"
    min={min}
    className="mt-0 w-28 font-normal"
    value={value}
    onChange={(e) => onChange(e.target.value)}
  />
);

/** Settings › Agents: runner, roles, review, retries, worktree, and the tools and models. */
export function AgentsPage({
  form,
  set,
  project,
  advancedOpen,
}: {
  form: AgentsValues;
  set: (update: (v: AgentsValues) => AgentsValues) => void;
  project: Project;
  /** Show the advanced sections (expanded view, or the page has unsaved edits). */
  advancedOpen: boolean;
}) {
  const g = form.global;
  const o = form.project;
  const setG = (patch: Partial<AgentsValues["global"]>) =>
    set((v) => ({ ...v, global: { ...v.global, ...patch } }));
  const setO = (patch: Partial<AgentsValues["project"]>) =>
    set((v) => ({ ...v, project: { ...v.project, ...patch } }));

  const [health, setHealth] = useState<Record<string, HealthResult> | null>(null);
  const [details, setDetails] = useState<Record<string, ToolModelDetails> | null>(null);
  const [fetched, setFetched] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [addFor, setAddFor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    const loadDetails = () =>
      api
        .modelDetails()
        .then((d) => !cancelled && setDetails(d))
        .catch(() => {});
    void loadDetails();
    void Promise.all([api.health(), api.models()])
      .then(([h, m]) => {
        if (cancelled) return;
        setHealth(h);
        setFetched(m);
        void loadDetails();
      })
      .catch(() => !cancelled && setFailed(true))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // The model lists a select offers: the draft's, plus what the tools report.
  const models = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const src of [g.models, fetched])
      for (const [tool, list] of Object.entries(src))
        out[tool] = [...new Set([...(out[tool] ?? []), ...list])];
    return out;
  }, [g.models, fetched]);
  const tools = Object.keys(models);

  const setRole = (role: RoleName, next: RoleAssignment | undefined) =>
    setG({
      roles: (() => {
        const { [role]: _drop, ...rest } = g.roles;
        return (next ? { ...rest, [role]: next } : rest) as typeof g.roles;
      })(),
    });
  const setOwnRole = (role: RoleName, next: RoleAssignment | undefined) => {
    const { [role]: _drop, ...rest } = o.roles;
    setO({ roles: next ? { ...rest, [role]: next } : rest });
  };

  return (
    <div className="flex max-w-[1000px] flex-col gap-8">
      <section className="flex flex-col gap-2">
        <h2 className={h2}>Runner</h2>
        <label className="flex flex-col gap-1.5 text-[length:var(--text-body)] font-medium">
          Tasks at once
          {countInput(g.concurrency, (v) => setG({ concurrency: v }), "Tasks at once", 1)}
          <span className="text-[length:var(--text-row)] font-normal text-ink-muted">
            At most one per project.
          </span>
        </label>
      </section>

      <section className="flex flex-col">
        <h2 className={h2}>Roles</h2>
        <OverrideHeader projectName={project.name} />
        {ROLES.map((role) => (
          <OverrideRow
            key={role}
            label={role[0].toUpperCase() + role.slice(1)}
            inherit={!o.roles[role]}
            onInherit={(inh) =>
              setOwnRole(
                role,
                inh ? undefined : (g.roles[role] ?? { tool: tools[0] ?? "", model: "" }),
              )
            }
            inheritedText={
              g.roles[role] ? roleModelLabel(g.roles[role]!.tool, g.roles[role]!.model) : "none"
            }
            global={
              <RoleSelects
                role={role}
                value={g.roles[role]}
                tools={tools}
                models={models}
                allowNone={role === "observer"}
                onChange={(n) => setRole(role, n)}
                onAddModel={setAddFor}
              />
            }
            override={
              <RoleSelects
                role={`${role} (this project)`}
                value={o.roles[role]}
                tools={tools}
                models={models}
                allowNone={false}
                onChange={(n) => setOwnRole(role, n)}
                onAddModel={setAddFor}
              />
            }
          />
        ))}
      </section>

      <AdvancedSection title="Review" className="flex flex-col" open={advancedOpen}>
        <OverrideHeader projectName={project.name} />
        <OverrideRow
          label="Only a reviewer approval finishes a task as done"
          inherit={o.gate === null}
          onInherit={(inh) => setO({ gate: inh ? null : g.gate })}
          inheritedText={g.gate ? "yes" : "no"}
          global={
            <label className="flex flex-row gap-2 items-center m-0 text-[length:var(--text-row)] font-normal">
              <input
                className="m-0 size-4 w-4"
                type="checkbox"
                checked={g.gate}
                onChange={(e) => setG({ gate: e.target.checked })}
              />
              Only a reviewer approval finishes a task as done
            </label>
          }
          override={
            <label className="flex flex-row gap-2 items-center m-0 text-[length:var(--text-row)] font-normal">
              <input
                className="m-0 size-4 w-4"
                type="checkbox"
                checked={o.gate ?? g.gate}
                onChange={(e) => setO({ gate: e.target.checked })}
              />
              Only a reviewer approval finishes a task as done (this project)
            </label>
          }
        />
        <OverrideRow
          label="Fix rounds per reviewing role"
          inherit={o.maxFixRounds === null}
          onInherit={(inh) => setO({ maxFixRounds: inh ? null : g.maxFixRounds })}
          inheritedText={g.maxFixRounds}
          global={countInput(g.maxFixRounds, (v) => setG({ maxFixRounds: v }), "Fix rounds", 0)}
          override={countInput(
            o.maxFixRounds ?? "",
            (v) => setO({ maxFixRounds: v }),
            "Fix rounds, this project",
            0,
          )}
        />
      </AdvancedSection>

      <AdvancedSection title="Retries" className="flex flex-col" open={advancedOpen}>
        <OverrideHeader projectName={project.name} />
        <OverrideRow
          label="Retries per step after a transient failure"
          inherit={o.transient === null}
          onInherit={(inh) => setO({ transient: inh ? null : g.transient })}
          inheritedText={g.transient}
          global={countInput(g.transient, (v) => setG({ transient: v }), "Retries", 0)}
          override={countInput(
            o.transient ?? "",
            (v) => setO({ transient: v }),
            "Retries, this project",
            0,
          )}
        />
      </AdvancedSection>

      <AdvancedSection title="Worktree" className="flex flex-col" open={advancedOpen}>
        <OverrideHeader projectName={project.name} />
        <OverrideRow
          label="When a task is done"
          inherit={o.onDone === null}
          onInherit={(inh) => setO({ onDone: inh ? null : g.onDone })}
          inheritedText={ON_DONE.find(([v]) => v === g.onDone)?.[1] ?? ""}
          global={
            <NativeSelect
              aria-label="When a task is done"
              className="w-full"
              value={g.onDone}
              onChange={(e) => setG({ onDone: e.target.value as typeof g.onDone })}
            >
              {ON_DONE.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </NativeSelect>
          }
          override={
            <NativeSelect
              aria-label="When a task is done, this project"
              className="w-full"
              value={o.onDone ?? g.onDone}
              onChange={(e) => setO({ onDone: e.target.value as typeof g.onDone })}
            >
              {ON_DONE.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </NativeSelect>
          }
        />
        <OverrideRow
          label="When a task fails"
          inherit={o.onFailure === null}
          onInherit={(inh) => setO({ onFailure: inh ? null : g.onFailure })}
          inheritedText={ON_FAILURE.find(([v]) => v === g.onFailure)?.[1] ?? ""}
          global={
            <NativeSelect
              aria-label="When a task fails"
              className="w-full"
              value={g.onFailure}
              onChange={(e) => setG({ onFailure: e.target.value as typeof g.onFailure })}
            >
              {ON_FAILURE.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </NativeSelect>
          }
          override={
            <NativeSelect
              aria-label="When a task fails, this project"
              className="w-full"
              value={o.onFailure ?? g.onFailure}
              onChange={(e) => setO({ onFailure: e.target.value as typeof g.onFailure })}
            >
              {ON_FAILURE.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </NativeSelect>
          }
        />
      </AdvancedSection>

      <AdvancedSection title="Tools and models" className="flex flex-col gap-3" open={advancedOpen}>
        {loading && (
          <p className="m-0 text-[length:var(--text-row)] text-ink-muted">Checking the tools…</p>
        )}
        {failed && (
          <div className="flex items-center gap-2 text-[length:var(--text-row)] text-ink-muted">
            Could not check the tools.
            <Button variant="outline" size="xs" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        )}
        {tools.map((tool) => {
          const info = details?.[tool];
          const h = health?.[tool];
          const ago = checkedAgo(info?.health?.checkedAt, Date.now());
          return (
            <div
              key={tool}
              className="flex flex-col gap-2 border-b border-line pb-3 last:border-b-0"
            >
              <div className="flex flex-wrap items-center gap-2 text-[length:var(--text-row)]">
                <strong className="text-[length:var(--text-body)]">
                  {info?.displayName ?? tool}
                </strong>
                {h && (
                  <TonePill tone={h.status === "available" ? "done" : "failed"}>
                    {h.status}
                  </TonePill>
                )}
                {h?.version && <span className="font-mono text-ink-muted">{h.version}</span>}
                {ago && <span className="text-ink-muted">{ago}</span>}
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="ml-auto"
                  onClick={() => setAddFor(tool)}
                >
                  Add model…
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(models[tool] ?? []).map((m) => {
                  // A model added on this page is not saved yet, so it counts as an added one.
                  const meta = info?.models.find((d) => d.id === m);
                  const src = SOURCE[meta?.source ?? "settings"];
                  return (
                    <span
                      key={m}
                      className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-[length:var(--text-meta)]"
                    >
                      <span className="font-mono">{m}</span>
                      {info && (
                        <span className="text-ink-muted" title={src.title}>
                          {src.label}
                        </span>
                      )}
                      {meta?.isDefault && <span className="text-done">default</span>}
                      {meta?.usedBy.map((u) => (
                        <span key={u} className="text-ink-muted" title={u}>
                          {usageLabel(u)}
                        </span>
                      ))}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
        {tools.length === 0 && !loading && (
          <p className="m-0 text-[length:var(--text-row)] text-ink-muted">
            No models detected yet.
          </p>
        )}
      </AdvancedSection>

      <AddModelDialog
        tool={addFor}
        onClose={() => setAddFor(null)}
        onAdd={(tool, model) =>
          setG({
            models: { ...g.models, [tool]: [...new Set([...(g.models[tool] ?? []), model])] },
          })
        }
      />
    </div>
  );
}
