import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  ApiError,
  type Goal,
  type GoalInput,
  type GoalStatus,
  type Plan,
  type SyncReport,
  type TaskView,
} from "../api.js";
import { Modal } from "./Modal.js";
import { GoalForm } from "./GoalForm.js";
import { PlanStatusBadge } from "./PlansTab.js";

const GOAL_STATUSES: GoalStatus[] = ["plan", "develop", "review", "done"];

/** Human-readable lines for an API error; invalid_plan carries one line per issue. */
function messages(e: unknown): string[] {
  if (e instanceof ApiError && e.code === "invalid_plan" && Array.isArray(e.details)) {
    return (e.details as { path?: string; message: string }[]).map((d) =>
      d.path ? `${d.path}: ${d.message}` : d.message,
    );
  }
  return [e instanceof Error ? e.message : String(e)];
}

function SpecView({ goal }: { goal: Goal }) {
  const s = goal.spec;
  return (
    <div className="spec-view">
      <p>
        <strong>Goal.</strong> {s.goal}
      </p>
      <p>
        <strong>Stack.</strong> {s.stack}
      </p>
      <div className="spec-cols">
        <div>
          <strong>Do</strong>
          <ul className="spec-list">
            {s.rules.do.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
        <div>
          <strong>Don&apos;t</strong>
          <ul className="spec-list">
            {s.rules.dont.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      </div>
      <p>
        <strong>Tests.</strong> {s.tests.strategy} · {s.tests.technology} ·{" "}
        <code>{s.tests.run}</code>
        {s.tests.coverage ? ` · coverage ${s.tests.coverage}` : ""}
      </p>
      {goal.model && (
        <p>
          <strong>Model.</strong> {goal.model}
        </p>
      )}
    </div>
  );
}

export function PlanDetail({
  projectId,
  planId,
  tasks,
  tick,
  onBack,
  onOpenTask,
  onReviewTask,
  onChange,
}: {
  projectId: string;
  planId: string;
  tasks: TaskView[];
  tick: number;
  onBack: () => void;
  onOpenTask: (taskId: string) => void;
  onReviewTask: (taskId: string) => void;
  onChange: () => void;
}) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Goal | "new" | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<{ goal: Goal; dependents: string[] } | null>(null);
  const [syncPreview, setSyncPreview] = useState<SyncReport | null>(null);
  const [syncDone, setSyncDone] = useState<SyncReport | null>(null);
  const [exported, setExported] = useState<Record<string, string> | null>(null);

  const load = useCallback(async () => {
    try {
      setPlan(await api.getPlan(projectId, planId));
    } catch (e) {
      setErrors(messages(e));
    }
  }, [projectId, planId]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.frontmatter.id, t])), [tasks]);

  /** Run a mutation; on a version conflict reload and say so, on other errors show them. */
  const mutate = async (
    fn: (p: Plan) => Promise<Plan | void>,
    onError?: (e: unknown) => boolean,
  ): Promise<boolean> => {
    if (!plan) return false;
    setErrors([]);
    setNotice(null);
    try {
      const next = await fn(plan);
      if (next) setPlan(next);
      else await load();
      onChange();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === "plan_version_conflict") {
        setNotice("Plan changed elsewhere — reloaded");
        setEditing(null);
        setDeleting(null);
        await load();
      } else if (!onError?.(e)) setErrors(messages(e));
      return false;
    }
  };

  if (!plan) {
    return (
      <div className="plans-tab">
        <button className="retry-btn" onClick={onBack}>
          ← Plans
        </button>
        {errors.map((m, i) => (
          <p key={i} className="error">
            {m}
          </p>
        ))}
      </div>
    );
  }

  const goals = [...plan.goals].sort((a, b) => a.order - b.order);
  const ids = goals.map((g) => g.id);
  const move = (i: number, d: -1 | 1) => {
    const order = [...ids];
    [order[i], order[i + d]] = [order[i + d], order[i]];
    void mutate((p) => api.reorderGoals(projectId, p, order));
  };
  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });

  const startSync = async () => {
    setErrors([]);
    try {
      setSyncPreview(await api.syncPlan(projectId, plan.id, true));
    } catch (e) {
      setErrors(messages(e));
    }
  };
  const confirmSync = async () => {
    try {
      const r = await api.syncPlan(projectId, plan.id, false);
      setSyncPreview(null);
      setSyncDone(r);
      setPlan(r.plan);
      onChange();
    } catch (e) {
      setSyncPreview(null);
      setErrors(messages(e));
    }
  };
  const doExport = async () => {
    setErrors([]);
    try {
      setExported(await api.exportPlan(projectId, plan.id));
    } catch (e) {
      setErrors(messages(e));
    }
  };

  const saveGoal = async (g: GoalInput) => {
    setFormErrors([]);
    const ok = await mutate(
      (p) => api.putGoal(projectId, p, g),
      (e) => {
        setFormErrors(messages(e));
        return true;
      },
    );
    if (ok) setEditing(null);
  };

  const removeGoal = async (cascade: boolean) => {
    if (!deleting) return;
    const g = deleting.goal;
    const ok = await mutate(
      (p) => api.deleteGoal(projectId, p, g.id, cascade),
      (e) => {
        if (e instanceof ApiError && e.code === "goal_has_dependents") {
          const d = (e.details as { dependents?: string[] } | undefined)?.dependents ?? [];
          setDeleting({ goal: g, dependents: d });
          return true;
        }
        return false;
      },
    );
    if (ok) setDeleting(null);
  };

  return (
    <div className="plans-tab plan-detail">
      <button className="retry-btn" onClick={onBack}>
        ← Plans
      </button>
      <div className="plan-header">
        <h2>{plan.title}</h2>
        <PlanStatusBadge status={plan.status} />
        <span className="plan-id">
          {plan.id} · version {plan.version}
        </span>
      </div>
      {plan.description && <p className="plan-desc">{plan.description}</p>}
      <div className="toolbar plan-actions">
        <label>
          <input
            type="checkbox"
            checked={plan.autoSync}
            onChange={(e) =>
              void mutate((p) => api.updatePlan(projectId, p, { autoSync: e.target.checked }))
            }
          />
          auto-sync
        </label>
        <label>
          bump to{" "}
          <select
            value={plan.bumpTo}
            onChange={(e) =>
              void mutate((p) =>
                api.updatePlan(projectId, p, { bumpTo: e.target.value as "review" | "done" }),
              )
            }
          >
            <option value="review">review</option>
            <option value="done">done</option>
          </select>
        </label>
        <button
          className="primary"
          disabled={plan.status !== "active"}
          title={
            plan.status === "active"
              ? "Create or update tasks from goals"
              : "Approve the plan first"
          }
          onClick={() => void startSync()}
        >
          Sync to tasks
        </button>
        <button className="retry-btn" onClick={() => void doExport()}>
          Export XML
        </button>
        {plan.status === "draft" && (
          <button
            className="retry-btn"
            onClick={() => void mutate((p) => api.updatePlan(projectId, p, { status: "active" }))}
          >
            Approve
          </button>
        )}
        {plan.status !== "archived" && (
          <button
            className="archive-btn"
            onClick={() => void mutate((p) => api.updatePlan(projectId, p, { status: "archived" }))}
          >
            ⊟ Archive
          </button>
        )}
      </div>
      {notice && <p className="plan-notice">{notice}</p>}
      {errors.map((m, i) => (
        <p key={i} className="error">
          {m}
        </p>
      ))}

      <table className="plan-table goal-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Id</th>
            <th>Title</th>
            <th>Status</th>
            <th>Deps</th>
            <th>Rev</th>
            <th>Task</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {goals.map((g, i) => {
            const task = g.taskId ? taskById.get(g.taskId) : undefined;
            return (
              <Fragment key={g.id}>
                <tr>
                  <td>{g.order}</td>
                  <td>
                    <code>{g.id}</code>
                  </td>
                  <td>
                    <button className="task-title" onClick={() => toggle(g.id)}>
                      {expanded.has(g.id) ? "▾" : "▸"} {g.title}
                    </button>
                  </td>
                  <td>
                    <select
                      value={g.status}
                      onChange={(e) =>
                        void mutate((p) =>
                          api.setGoalStatus(projectId, p, g.id, e.target.value as GoalStatus),
                        )
                      }
                    >
                      {GOAL_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{g.dependsOn.join(", ") || "–"}</td>
                  <td>{g.revision}</td>
                  <td>
                    {g.taskId ? (
                      <button
                        className="plan-task-link"
                        title="Open this task in the editor"
                        onClick={() => onOpenTask(g.taskId!)}
                      >
                        {task && (
                          <span className={`status-badge ${task.frontmatter.status}`}>
                            {task.frontmatter.status}
                          </span>
                        )}{" "}
                        {g.taskId}
                      </button>
                    ) : (
                      "–"
                    )}
                    {g.taskId &&
                      (task?.frontmatter.status === "done" ||
                        task?.frontmatter.status === "failed") && (
                        <>
                          {" "}
                          <button
                            className="retry-btn"
                            title="See what this goal's task changed"
                            onClick={() => onReviewTask(g.taskId!)}
                          >
                            Review changes
                          </button>
                        </>
                      )}
                  </td>
                  <td className="goal-actions">
                    <button
                      className="btn-icon"
                      disabled={i === 0}
                      title="Move up"
                      onClick={() => move(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      className="btn-icon"
                      disabled={i === goals.length - 1}
                      title="Move down"
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => {
                        setFormErrors([]);
                        setEditing(g);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="delete-btn"
                      onClick={() => setDeleting({ goal: g, dependents: [] })}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
                {expanded.has(g.id) && (
                  <tr className="spec-row">
                    <td colSpan={8}>
                      <SpecView goal={g} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {goals.length === 0 && <p className="empty">This plan has no goals yet.</p>}
      <div className="toolbar">
        <button
          className="retry-btn"
          onClick={() => {
            setFormErrors([]);
            setEditing("new");
          }}
        >
          + Add goal
        </button>
      </div>

      {editing && (
        <GoalForm
          goal={editing === "new" ? null : editing}
          others={ids.filter((id) => editing === "new" || id !== editing.id)}
          error={formErrors}
          onSave={(g) => void saveGoal(g)}
          onClose={() => setEditing(null)}
        />
      )}

      {deleting && (
        <Modal title={`Delete goal ${deleting.goal.id}`} onClose={() => setDeleting(null)}>
          {deleting.dependents.length > 0 ? (
            <p className="error">
              Goals that depend on it: {deleting.dependents.join(", ")}. Delete them as well (and
              stop their running tasks)?
            </p>
          ) : (
            <p>
              Delete “{deleting.goal.title}” from the plan? Its task is archived on the next sync.
            </p>
          )}
          <div className="editor-actions">
            <button
              className="primary"
              onClick={() => void removeGoal(deleting.dependents.length > 0)}
            >
              {deleting.dependents.length > 0 ? "Delete with dependents" : "Delete"}
            </button>
            <button onClick={() => setDeleting(null)}>Cancel</button>
          </div>
        </Modal>
      )}

      {syncPreview && (
        <Modal title="Sync preview (dry run)" onClose={() => setSyncPreview(null)}>
          <SyncSummary r={syncPreview} />
          <div className="editor-actions">
            <button className="primary" onClick={() => void confirmSync()}>
              Sync now
            </button>
            <button onClick={() => setSyncPreview(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {syncDone && (
        <Modal title="Sync complete" onClose={() => setSyncDone(null)}>
          <SyncSummary r={syncDone} />
          <div className="editor-actions">
            <button onClick={() => setSyncDone(null)}>Close</button>
          </div>
        </Modal>
      )}
      {exported && <ExportModal files={exported} onClose={() => setExported(null)} />}
    </div>
  );
}

function SyncSummary({ r }: { r: SyncReport }) {
  const section = (title: string, rows: string[]) => (
    <div className="sync-section">
      <h4>
        {title} ({rows.length})
      </h4>
      {rows.length === 0 ? (
        <p className="plan-id">none</p>
      ) : (
        <ul className="spec-list">
          {rows.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <>
      {section(
        "Created",
        r.created.map((c) => `${c.goalId} → ${c.taskId} (${c.status})`),
      )}
      {section(
        "Updated",
        r.updated.map((c) => `${c.goalId} → ${c.taskId} (${c.action})`),
      )}
      {section(
        "Skipped",
        r.skipped.map((c) => `${c.goalId} (${c.reason})`),
      )}
      {section(
        "Archived",
        r.archived.map((c) => `${c.goalId} → ${c.taskId} (${c.action})`),
      )}
    </>
  );
}

function ExportModal({ files, onClose }: { files: Record<string, string>; onClose: () => void }) {
  const entries = useMemo(
    () =>
      Object.entries(files).map(([name, xml]) => ({
        name,
        url: URL.createObjectURL(new Blob([xml], { type: "application/xml" })),
      })),
    [files],
  );
  useEffect(() => () => entries.forEach((e) => URL.revokeObjectURL(e.url)), [entries]);
  return (
    <Modal title="Export XML" onClose={onClose}>
      <ul className="spec-list export-list">
        {entries.map((e) => (
          <li key={e.name}>
            <code>{e.name}</code>{" "}
            <a href={e.url} download={e.name.split("/").pop()}>
              Download
            </a>
          </li>
        ))}
      </ul>
      <div className="editor-actions">
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
