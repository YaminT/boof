import { useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api } from "../api.js";
import type { Status } from "@boof-runner/shared/schema";
import type { Task } from "@boof-runner/shared/task-types";

const STATUS_LABEL: Record<Status, string> = {
  draft: "Draft",
  pending: "Pending",
  running: "Running",
  action: "Action",
  done: "Done",
  failed: "Failed",
  archived: "Archived",
};

const STATUS_FILTERS: Status[] = [
  "draft",
  "pending",
  "running",
  "action",
  "done",
  "failed",
  "archived",
];

/** Labels the plan sync puts on tasks; shown with an accent. */
const PLAN_LABELS = new Set(["blocked", "needs-review", "stale-revision", "goal-removed"]);

function Row({
  projectId,
  task,
  onEdit,
  onReview,
  onChange,
}: {
  projectId: string;
  task: Task;
  onEdit: (id: string) => void;
  onReview: (id: string) => void;
  onChange: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: task.frontmatter.id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const f = task.frontmatter;
  return (
    <li ref={setNodeRef} style={style} className="task-row">
      <span className="drag" {...attributes} {...listeners}>
        ⠿
      </span>
      <span className={`status-badge ${f.status}`}>{STATUS_LABEL[f.status]}</span>
      <button className="task-title" onClick={() => onEdit(f.id)}>
        {f.title}
      </button>
      <span className="priority">P{f.priority}</span>
      {f.runs > 1 && (
        <span className="runs" title="completed runs / requested runs">
          {f.completedRuns}/{f.runs} runs
        </span>
      )}
      <span className="labels">
        {f.planRef && (
          <span className="label plan-chip" title="Created from a plan goal">
            plan: {f.planRef.planId} · goal: {f.planRef.goalId}
          </span>
        )}
        {f.labels.map((l) => (
          <span
            key={l}
            className={`label${PLAN_LABELS.has(l) ? " plan-label" : ""}${l === "stale-revision" || l === "goal-removed" ? " warn" : ""}`}
          >
            {l}
          </span>
        ))}
      </span>
      {(f.status === "done" || f.status === "failed") && (
        <button
          className="retry-btn"
          title="See what this task changed before you retry, archive or merge it"
          onClick={() => onReview(f.id)}
        >
          Review changes
        </button>
      )}
      {f.status === "failed" && (
        <button
          className="retry-btn"
          title="Clear the failed status and re-queue this task"
          onClick={async () => {
            await api.retry(projectId, f.id);
            onChange();
          }}
        >
          ↻ Retry
        </button>
      )}
      {f.status === "archived" ? (
        <button
          className="retry-btn"
          title="Unarchive and re-queue this task"
          onClick={async () => {
            await api.unarchive(projectId, f.id);
            onChange();
          }}
        >
          ⇡ Unarchive
        </button>
      ) : (
        f.status !== "running" && (
          <button
            className="archive-btn"
            title="Archive this task"
            onClick={async () => {
              await api.archive(projectId, f.id);
              onChange();
            }}
          >
            ⊟ Archive
          </button>
        )
      )}
      <label className="skip">
        <input
          type="checkbox"
          checked={f.skip}
          onChange={async (e) => {
            await api.setSkip(projectId, f.id, e.target.checked);
            onChange();
          }}
        />
        skip
      </label>
      {f.status !== "running" && (
        <button
          className="delete-btn"
          title="Delete this task permanently"
          onClick={async () => {
            if (!confirm(`Delete “${f.title}” permanently? This cannot be undone.`)) return;
            await api.deleteTask(projectId, f.id);
            onChange();
          }}
        >
          ✕ Delete
        </button>
      )}
    </li>
  );
}

export function TaskList({
  projectId,
  tasks,
  onEdit,
  onReview,
  onChange,
  onNew,
}: {
  projectId: string;
  tasks: Task[];
  onEdit: (id: string) => void;
  onReview: (id: string) => void;
  onChange: () => void;
  onNew: () => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [labelFilter, setLabelFilter] = useState<string>("");
  const [groupByLabel, setGroupByLabel] = useState(false);
  // "active" = everything except archived (default); "all" = include archived;
  // otherwise an exact status match.
  const [statusFilter, setStatusFilter] = useState<"active" | "all" | "proposed" | Status>(
    "active",
  );

  const allLabels = useMemo(
    () => [...new Set(tasks.flatMap((t) => t.frontmatter.labels))].sort(),
    [tasks],
  );

  const statusCounts = useMemo(() => {
    const m: Partial<Record<Status, number>> = {};
    for (const t of tasks) m[t.frontmatter.status] = (m[t.frontmatter.status] ?? 0) + 1;
    return m;
  }, [tasks]);

  const proposedCount = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.frontmatter.status === "draft" &&
          t.frontmatter.labels.some((l) => l.startsWith("external:")),
      ).length,
    [tasks],
  );

  const filtered = useMemo(
    () =>
      tasks.filter((t) => {
        const s = t.frontmatter.status;
        const statusOk =
          statusFilter === "all"
            ? true
            : statusFilter === "active"
              ? s !== "archived"
              : statusFilter === "proposed"
                ? s === "draft" && t.frontmatter.labels.some((l) => l.startsWith("external:"))
                : s === statusFilter;
        const labelOk = !labelFilter || t.frontmatter.labels.includes(labelFilter);
        return statusOk && labelOk;
      }),
    [tasks, labelFilter, statusFilter],
  );

  // Sorted by priority desc for display + reorder baseline.
  const ordered = useMemo(
    () => [...filtered].sort((a, b) => b.frontmatter.priority - a.frontmatter.priority),
    [filtered],
  );

  const onDragEnd = async (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = ordered.map((t) => t.frontmatter.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    const next = arrayMove(ids, from, to);
    await api.reorder(projectId, next);
    onChange();
  };

  const groups = useMemo(() => {
    if (!groupByLabel) return [{ label: null as string | null, items: ordered }];
    const map = new Map<string, Task[]>();
    for (const t of ordered) {
      const keys = t.frontmatter.labels.length ? t.frontmatter.labels : ["(no label)"];
      for (const k of keys) map.set(k, [...(map.get(k) ?? []), t]);
    }
    return [...map.entries()].map(([label, items]) => ({ label, items }));
  }, [groupByLabel, ordered]);

  return (
    <div className="task-list">
      <div className="toolbar">
        <button className="primary" onClick={onNew}>
          + New task
        </button>
        <select
          value={statusFilter}
          onChange={(e) =>
            setStatusFilter(e.target.value as "active" | "all" | "proposed" | Status)
          }
        >
          <option value="active">Active (no archived)</option>
          <option value="all">All statuses</option>
          <option value="proposed">
            Proposed by clients{proposedCount ? ` (${proposedCount})` : ""}
          </option>
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
              {statusCounts[s] ? ` (${statusCounts[s]})` : ""}
            </option>
          ))}
        </select>
        <select value={labelFilter} onChange={(e) => setLabelFilter(e.target.value)}>
          <option value="">All labels</option>
          {allLabels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <label>
          <input
            type="checkbox"
            checked={groupByLabel}
            onChange={(e) => setGroupByLabel(e.target.checked)}
          />
          group by label
        </label>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        {groups.map((g) => (
          <div key={g.label ?? "_"} className="group">
            {g.label && <h3>{g.label}</h3>}
            <SortableContext
              items={g.items.map((t) => t.frontmatter.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul>
                {g.items.map((t) => (
                  <Row
                    key={t.frontmatter.id}
                    projectId={projectId}
                    task={t}
                    onEdit={onEdit}
                    onReview={onReview}
                    onChange={onChange}
                  />
                ))}
              </ul>
            </SortableContext>
          </div>
        ))}
      </DndContext>
      {tasks.length === 0 && <p className="empty">No tasks yet. Create one to get started.</p>}
    </div>
  );
}
