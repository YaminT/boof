import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type PlanSummary } from "../api.js";
import type { TaskView } from "../api.js";
import { Modal } from "./Modal.js";
import { PlanDetail } from "./PlanDetail.js";

export function PlanStatusBadge({ status }: { status: string }) {
  return <span className={`status-badge plan-${status}`}>{status}</span>;
}

const fmt = (iso: string) => new Date(iso).toLocaleString();

/** Plans of a project: the list, with the detail view of one plan opened in place. */
export function PlansTab({
  projectId,
  tasks,
  tick,
  planId,
  onSelectPlan,
  onOpenTask,
  onChange,
}: {
  projectId: string;
  tasks: TaskView[];
  /** Bumped when a plan.* event arrives; reloads the data. */
  tick: number;
  planId: string | null;
  onSelectPlan: (id: string | null) => void;
  onOpenTask: (taskId: string) => void;
  onChange: () => void;
}) {
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importMsg, setImportMsg] = useState<{
    text: string[];
    conflict?: boolean;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      setPlans(await api.listPlans(projectId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  const runImport = async (merge: boolean) => {
    try {
      const r = await api.importPlan(projectId, merge ? { merge: true } : {});
      setImportMsg({
        text: [
          `Imported plan “${r.plan.title}”: ${r.added.length} added, ${r.updated.length} updated, ${r.unchanged.length} unchanged.`,
          ...r.warnings,
        ],
      });
      await load();
      onChange();
    } catch (e) {
      setImportMsg({
        text: [e instanceof Error ? e.message : String(e)],
        conflict: e instanceof ApiError && e.code === "plan_exists",
      });
    }
  };

  if (planId) {
    return (
      <PlanDetail
        projectId={projectId}
        planId={planId}
        tasks={tasks}
        tick={tick}
        onBack={() => {
          onSelectPlan(null);
          void load();
        }}
        onOpenTask={onOpenTask}
        onChange={() => {
          void load();
          onChange();
        }}
      />
    );
  }

  return (
    <div className="plans-tab">
      <div className="toolbar">
        <button className="primary" onClick={() => setCreating(true)}>
          + New plan
        </button>
        <button className="retry-btn" onClick={() => void runImport(false)}>
          Import from repo
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {plans && plans.length === 0 && (
        <p className="empty">No plans yet. Create one or import plan.boof.xml from the repo.</p>
      )}
      {plans && plans.length > 0 && (
        <table className="plan-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Auto-sync</th>
              <th>Goals done</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id}>
                <td>
                  <button className="task-title" onClick={() => onSelectPlan(p.id)}>
                    {p.title}
                  </button>
                  <div className="plan-id">{p.id}</div>
                </td>
                <td>
                  <PlanStatusBadge status={p.status} />
                </td>
                <td>{p.autoSync ? "on" : "off"}</td>
                <td>
                  {p.doneCount}/{p.goalCount}
                </td>
                <td className="plan-date">{fmt(p.updated)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && (
        <NewPlanModal
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            onSelectPlan(id);
            onChange();
          }}
        />
      )}
      {importMsg && (
        <Modal title="Import from repo" onClose={() => setImportMsg(null)}>
          {importMsg.text.map((t, i) => (
            <p key={i} className={i > 0 || importMsg.conflict ? "error" : undefined}>
              {t}
            </p>
          ))}
          <div className="editor-actions">
            {importMsg.conflict && (
              <button
                className="primary"
                onClick={() => {
                  setImportMsg(null);
                  void runImport(true);
                }}
              >
                Merge into the existing plan
              </button>
            )}
            <button onClick={() => setImportMsg(null)}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function NewPlanModal({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="New plan" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          api
            .createPlan(projectId, {
              title: title.trim(),
              ...(description.trim() ? { description: description.trim() } : {}),
            })
            .then((p) => onCreated(p.id))
            .catch((err) => setError(err instanceof Error ? err.message : String(err)));
        }}
      >
        <label>
          Title
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Description
          <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="editor-actions">
          <button className="primary" type="submit" disabled={!title.trim()}>
            Create
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
