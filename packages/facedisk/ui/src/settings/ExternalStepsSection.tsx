import { useEffect, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from "lucide-react";
import type { ExternalStep, Project } from "@boof/heart/schema";
import { api } from "../api.js";
import type { N8nInfo, N8nWorkflowsResult, Whoami } from "../api-types.js";
import { act } from "../lib/act.js";
import {
  canEditExternalSteps,
  moveStep,
  shortWebhookPath,
  stepDraftErrors,
  stepIdOf,
  TRUST_RULE,
  usableWebhooks,
  type ExternalStepDraft,
} from "../lib/external-steps.js";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { NativeSelect } from "@/ui/native-select";

const label = "flex min-w-0 flex-col gap-1 text-sm font-medium";
const POINTS: { value: ExternalStep["at"]; text: string }[] = [
  { value: "after-planner", text: "After planner" },
  { value: "after-developer", text: "After developer" },
  { value: "after-review", text: "After review" },
];
let counter = 0;
const newKey = () => `new-${++counter}`;
const MAX_STEPS = 10;

const toDrafts = (steps: ExternalStep[] | undefined): ExternalStepDraft[] =>
  (steps ?? []).map((s) => ({ ...s, key: s.id }));

/** Settings › Project: the project's external (n8n) steps. Saved through projects.update. */
export function ExternalStepsSection({
  project,
  whoami,
  onSaved,
}: {
  project: Project;
  whoami: Whoami | null;
  onSaved: () => void | Promise<void>;
}) {
  const [info, setInfo] = useState<N8nInfo | null>(null);
  const [cache, setCache] = useState<N8nWorkflowsResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [rows, setRows] = useState<ExternalStepDraft[]>(() => toDrafts(project.externalSteps));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const canEdit = canEditExternalSteps(whoami);

  useEffect(() => {
    setRows(toDrafts(project.externalSteps));
    setAttempted(false);
    setServerError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, JSON.stringify(project.externalSteps ?? [])]);
  useEffect(() => {
    let live = true;
    Promise.all([api.getN8n(), api.listN8nWorkflows()])
      .then(([i, c]) => {
        if (!live) return;
        setInfo(i);
        setCache(c);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  const heading = (
    <h2 className="m-0 text-[length:var(--text-section)] font-semibold">External steps (n8n)</h2>
  );
  if (failed)
    return (
      <section className="flex flex-col gap-3">
        {heading}
        <p className="m-0 text-[length:var(--text-row)] text-ink-muted">
          Could not load the n8n connection.
        </p>
      </section>
    );
  if (!info || !cache) return null;
  if (!info.configured)
    return (
      <section className="flex flex-col gap-3">
        {heading}
        <p className="m-0 text-[length:var(--text-body)] text-ink-muted">
          Connect n8n in Settings › Automation to add external steps.
        </p>
      </section>
    );

  const errors = stepDraftErrors(rows);
  const patchRow = (i: number, patch: Partial<ExternalStepDraft>) =>
    setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const workflowOf = (id: string | undefined) => cache.workflows.find((w) => w.id === id);
  const original = JSON.stringify(project.externalSteps ?? []);

  const save = async () => {
    setAttempted(true);
    setServerError(null);
    if (Object.keys(errors).length > 0 || busy) return;
    const steps: ExternalStep[] = rows.map((r) => ({
      id: stepIdOf(r),
      label: (r.label ?? "").trim(),
      at: r.at ?? "after-developer",
      workflowId: r.workflowId ?? "",
      webhookPath: r.webhookPath ?? "",
      ...(r.timeoutMs !== undefined ? { timeoutMs: r.timeoutMs } : {}),
      onFailure: r.onFailure ?? "fail",
      sendDiff: r.sendDiff ?? false,
    }));
    setBusy(true);
    const ok = await act(
      () => api.updateProject(project.id, { externalSteps: steps.length === 0 ? null : steps }),
      {
        success: "External steps saved",
        failure: "Could not save the external steps",
        // A refusal for a review-trust key reads best next to the rows.
        onError: (e) => {
          const m = e instanceof Error ? e.message : String(e);
          if ((e as { status?: number }).status === 403) {
            setServerError(m);
            return true;
          }
          return false;
        },
      },
    );
    setBusy(false);
    if (ok) await onSaved();
  };

  return (
    <section className="flex flex-col gap-3">
      {heading}
      {!canEdit && <p className="m-0 text-[length:var(--text-row)] text-attention">{TRUST_RULE}</p>}
      {rows.length === 0 && (
        <p className="m-0 text-[length:var(--text-row)] text-ink-muted">
          No external steps. Add one to run an n8n workflow during a task.
        </p>
      )}
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {rows.map((r, i) => {
          const wf = workflowOf(r.workflowId);
          const hooks = wf ? usableWebhooks(wf) : [];
          const eligible = cache.workflows.filter((w) => usableWebhooks(w).length > 0);
          const missing = r.workflowId && !wf;
          return (
            <li
              key={r.key}
              className="flex flex-col gap-2 rounded-lg border border-line p-3"
              aria-label={`External step ${i + 1}`}
            >
              <div className="grid grid-cols-1 gap-2 min-[720px]:grid-cols-2">
                <label className={label}>
                  Label
                  <Input
                    className="mt-0 font-normal"
                    value={r.label ?? ""}
                    disabled={!canEdit}
                    onChange={(e) => patchRow(i, { label: e.target.value })}
                  />
                </label>
                <label className={label}>
                  Workflow
                  <NativeSelect
                    className="w-full"
                    value={r.workflowId ?? ""}
                    disabled={!canEdit}
                    onChange={(e) => {
                      const w = workflowOf(e.target.value);
                      const h = w ? usableWebhooks(w) : [];
                      patchRow(i, {
                        workflowId: e.target.value || undefined,
                        webhookPath: h.length === 1 ? h[0]?.path : undefined,
                      });
                    }}
                  >
                    <option value="">Choose a workflow…</option>
                    {missing && (
                      <option value={r.workflowId}>{r.workflowId} (not in the list)</option>
                    )}
                    {eligible.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                        {w.active ? "" : " (inactive)"}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label className={label}>
                  Webhook
                  <NativeSelect
                    className="w-full"
                    value={r.webhookPath ?? ""}
                    disabled={!canEdit || !r.workflowId}
                    onChange={(e) => patchRow(i, { webhookPath: e.target.value || undefined })}
                  >
                    <option value="">Choose a webhook…</option>
                    {r.webhookPath && !hooks.some((h) => h.path === r.webhookPath) && (
                      <option value={r.webhookPath}>
                        POST /{shortWebhookPath(r.webhookPath)} (not usable)
                      </option>
                    )}
                    {hooks.map((h) => (
                      <option key={h.path} value={h.path}>
                        POST /{shortWebhookPath(h.path)}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label className={label}>
                  Runs
                  <NativeSelect
                    className="w-full"
                    value={r.at ?? "after-developer"}
                    disabled={!canEdit}
                    onChange={(e) => patchRow(i, { at: e.target.value as ExternalStep["at"] })}
                  >
                    {POINTS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.text}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label className={label}>
                  Timeout (minutes)
                  <Input
                    className="mt-0 font-normal"
                    inputMode="numeric"
                    placeholder="Default"
                    disabled={!canEdit}
                    value={r.timeoutMs === undefined ? "" : String(r.timeoutMs / 60_000)}
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      const n = Number(v);
                      patchRow(i, {
                        timeoutMs:
                          v === "" || !Number.isFinite(n) || n <= 0
                            ? undefined
                            : Math.round(n * 60_000),
                      });
                    }}
                  />
                </label>
                <label className={label}>
                  If it fails
                  <NativeSelect
                    className="w-full"
                    value={r.onFailure ?? "fail"}
                    disabled={!canEdit}
                    onChange={(e) =>
                      patchRow(i, { onFailure: e.target.value as "fail" | "continue" })
                    }
                  >
                    <option value="fail">Fail the task</option>
                    <option value="continue">Continue</option>
                  </NativeSelect>
                </label>
              </div>
              <label className="m-0 flex flex-row items-center gap-2 text-[length:var(--text-row)] font-normal">
                <input
                  type="checkbox"
                  className="m-0 size-4 w-4"
                  checked={r.sendDiff ?? false}
                  disabled={!canEdit}
                  onChange={(e) => patchRow(i, { sendDiff: e.target.checked })}
                />
                Send the diff
              </label>
              {attempted && errors[i] && (
                <p role="alert" className="m-0 text-[length:var(--text-row)] text-failed">
                  {errors[i]}
                </p>
              )}
              {canEdit && (
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Move step ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => setRows((x) => moveStep(x, i, i - 1))}
                  >
                    <ArrowUpIcon className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Move step ${i + 1} down`}
                    disabled={i === rows.length - 1}
                    onClick={() => setRows((x) => moveStep(x, i, i + 1))}
                  >
                    <ArrowDownIcon className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Remove step ${i + 1}`}
                    onClick={() => setRows((x) => x.filter((_, j) => j !== i))}
                  >
                    <Trash2Icon className="size-4" /> Remove
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {serverError && (
        <p role="alert" className="m-0 text-[length:var(--text-row)] text-failed">
          {serverError}
        </p>
      )}
      {canEdit && (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={rows.length >= MAX_STEPS}
            onClick={() =>
              setRows((x) => [
                ...x,
                { key: newKey(), at: "after-developer", onFailure: "fail", sendDiff: false },
              ])
            }
          >
            Add step
          </Button>
          <Button
            type="button"
            disabled={busy || JSON.stringify(rows.map(({ key: _k, ...s }) => s)) === original}
            onClick={() => void save()}
          >
            Save steps
          </Button>
        </div>
      )}
    </section>
  );
}
