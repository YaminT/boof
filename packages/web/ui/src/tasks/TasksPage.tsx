import { useEffect, useMemo, useRef, useState } from "react";
import { api, type TaskView } from "../api.js";
import { Button } from "@/ui/button";
import { act } from "../lib/act.js";
import type { Route } from "../lib/route.js";
import { groupTasks, runOrder } from "../lib/task-groups.js";
import {
  allLabels,
  filterTasks,
  listKeyAction,
  moveQueued,
  type TaskFilter,
} from "../lib/task-list.js";
import { StopTaskDialog } from "../shell/StopTaskDialog.js";
import type { AppData } from "../useAppData.js";
import { QueuedSection } from "./QueuedSection.js";
import { TaskRow, type RowContext, type RowEntry } from "./TaskRow.js";
import { TaskSection } from "./TaskSection.js";
import { TasksToolbar } from "./TasksToolbar.js";
import { useTaskActions } from "./useTaskActions.js";

const NO_FILTER: TaskFilter = { query: "", state: "all", label: null };
const FINISHED = new Set(["done", "failed", "stopped", "archived"]);

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

type Task = Exclude<RowEntry, { kind: "plan" }>;

/** The Tasks screen: tasks grouped by what they wait for, with search, filters and the keyboard. */
export function TasksPage({
  pid,
  data,
  navigate,
}: {
  pid: string;
  data: AppData;
  navigate: (to: Route) => void;
}) {
  const actions = useTaskActions(pid, data, navigate);
  const [filter, setFilter] = useState(NO_FILTER);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(false);
  const [stopId, setStopId] = useState<string | null>(null);
  // The queue order while a reorder is in flight; null shows the server's order.
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const inFlight = useRef(0);

  const { tasks, plans } = data;
  const filtered = useMemo(() => filterTasks(tasks, filter), [tasks, filter]);
  const groups = useMemo(() => groupTasks(filtered), [filtered]);
  const labels = useMemo(() => allLabels(tasks), [tasks]);
  const byStatus = (s: string) => filtered.filter((t) => t.frontmatter.status === s);

  const allPending = useMemo(
    () => tasks.filter((t) => t.frontmatter.status === "pending").sort(runOrder),
    [tasks],
  );
  const shownPending = useMemo(() => byStatus("pending").sort(runOrder), [filtered]);
  const canReorder = shownPending.length === allPending.length;
  const queuedOrder = useMemo(() => {
    const ids = shownPending.map((t) => t.frontmatter.id);
    if (!localOrder) return ids;
    const at = (id: string) => (localOrder.includes(id) ? localOrder.indexOf(id) : ids.length);
    return [...ids].sort((a, b) => at(a) - at(b));
  }, [shownPending, localOrder]);

  const rows = useMemo(() => {
    const q = filter.query.trim().toLowerCase();
    const plansShown =
      (filter.state === "all" || filter.state === "needs-you") && filter.label === null
        ? plans.filter((p) => p.status === "draft" && (!q || p.title.toLowerCase().includes(q)))
        : [];
    const task = (kind: Task["kind"], t: TaskView): Task =>
      ({ key: `task:${t.frontmatter.id}`, kind, task: t }) as Task;
    const needs: RowEntry[] = [
      ...groups.needsYou.flatMap((i) => (i.kind === "question" ? [task("question", i.task)] : [])),
      ...plansShown.map((p): RowEntry => ({ key: `plan:${p.id}`, kind: "plan", plan: p })),
    ];
    const proposed = groups.needsYou.flatMap((i) =>
      i.kind === "proposed" ? [task("proposed", i.task)] : [],
    );
    const byId = new Map(shownPending.map((t) => [t.frontmatter.id, t]));
    let n = 0;
    const queued = queuedOrder.map((id): Extract<RowEntry, { kind: "queued" }> => {
      const t = byId.get(id)!;
      return {
        key: `task:${id}`,
        kind: "queued",
        task: t,
        pos: t.frontmatter.skip ? null : ++n,
      };
    });
    const finished = filtered
      .filter((t) => FINISHED.has(t.frontmatter.status))
      .sort((a, b) => (a.frontmatter.updated < b.frontmatter.updated ? 1 : -1));
    return {
      needs,
      proposed,
      running: groups.running.map((t) => task("running", t)),
      queued,
      drafts: [...groups.drafts].sort(runOrder).map((t) => task("draft", t)),
      finished: finished.map((t) => task("finished", t)),
    };
  }, [groups, plans, filter, filtered, shownPending, queuedOrder]);

  const finishedOpen = showFinished || filter.state === "finished";
  const visible: RowEntry[] = [
    ...rows.needs,
    ...rows.proposed,
    ...rows.running,
    ...rows.queued,
    ...rows.drafts,
    ...(finishedOpen ? rows.finished : []),
  ];
  const total = visible.length + (finishedOpen ? 0 : rows.finished.length);
  const selected = visible.find((r) => r.key === selectedKey) ?? null;

  const reorder = (order: string[]) => {
    setLocalOrder(order);
    inFlight.current++;
    void act(() => api.reorder(pid, order), { failure: "Could not reorder" })
      .then(() => data.refresh())
      .finally(() => {
        // Show the server's order again: the new one on success, the old one if it failed.
        if (--inFlight.current === 0) setLocalOrder(null);
      });
  };

  // Keep the handler current without re-subscribing on every render.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e) => {
    const target = e.target as HTMLElement | null;
    const dialogOpen = stopId !== null || !!document.querySelector("[role=dialog], [role=menu]");
    const action = listKeyAction(e, isTyping(target), dialogOpen);
    if (!action) return;
    // Enter on a focused button or link belongs to that control.
    if (action === "open" && target?.closest("button, a, [role=menuitem]")) return;
    const i = selected ? visible.indexOf(selected) : -1;
    const select = (j: number) => {
      const next = visible[Math.max(0, Math.min(visible.length - 1, j))];
      if (!next) return;
      setSelectedKey(next.key);
      document
        .querySelector(`[data-row-key="${CSS.escape(next.key)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    };
    e.preventDefault();
    if (action === "down") return select(i + 1);
    if (action === "up") return select(i < 0 ? 0 : i - 1);
    if (!selected) return;
    if (selected.kind === "plan")
      return action === "open" ? actions.openPlan(selected.plan.id) : undefined;
    const id = selected.task.frontmatter.id;
    if (action === "open") return actions.open(id);
    if (action === "queue" && (selected.kind === "draft" || selected.kind === "proposed"))
      return actions.queue(id);
    if (action === "stop" && selected.kind === "running") return setStopId(id);
    if (
      (action === "move-up" || action === "move-down") &&
      selected.kind === "queued" &&
      canReorder
    ) {
      const next = moveQueued(queuedOrder, id, action === "move-up" ? -1 : 1);
      if (next) reorder(next);
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const ctx: RowContext = {
    pid,
    actions,
    selectedKey: selected?.key ?? null,
    onSelect: setSelectedKey,
    onStop: setStopId,
  };
  const list = (entries: RowEntry[]) => (
    <ul className="m-0 list-none p-0">
      {entries.map((e) => (
        <TaskRow key={e.key} entry={e} ctx={ctx} />
      ))}
    </ul>
  );
  const newTask = () => navigate({ name: "task", pid, taskId: "__new__", view: "edit" });
  const counts = { done: 0, failed: 0, stopped: 0, archived: 0 };
  for (const r of rows.finished) counts[r.task.frontmatter.status as keyof typeof counts]++;

  return (
    <div>
      <TasksToolbar filter={filter} labels={labels} onFilter={setFilter} onNew={newTask} />
      {data.tasksLoaded && tasks.length === 0 && plans.every((p) => p.status !== "draft") && (
        <div className="py-8">
          <p className="mt-0 mb-3 text-ink-muted">
            No tasks yet. Add one, or let a harness submit a plan.
          </p>
          <Button onClick={newTask}>New task</Button>
        </div>
      )}
      {data.tasksLoaded && total === 0 && tasks.length > 0 && (
        <div className="py-8">
          <p className="mt-0 mb-3 text-ink-muted">
            No tasks match. Clear the search or the filters.
          </p>
          <Button variant="outline" onClick={() => setFilter(NO_FILTER)}>
            Clear filters
          </Button>
        </div>
      )}
      {rows.needs.length > 0 && (
        <TaskSection title="Needs you" count={rows.needs.length}>
          {list(rows.needs)}
        </TaskSection>
      )}
      {rows.proposed.length > 0 && (
        <TaskSection title="Proposed" count={rows.proposed.length}>
          {list(rows.proposed)}
        </TaskSection>
      )}
      {rows.running.length > 0 && (
        <TaskSection title="Running" count={rows.running.length}>
          {list(rows.running)}
        </TaskSection>
      )}
      {rows.queued.length > 0 && (
        <QueuedSection
          entries={rows.queued}
          ctx={ctx}
          canReorder={canReorder}
          onReorder={reorder}
        />
      )}
      {rows.drafts.length > 0 && (
        <TaskSection title="Drafts" count={rows.drafts.length}>
          {list(rows.drafts)}
        </TaskSection>
      )}
      {rows.finished.length > 0 && (
        <TaskSection title="Finished">
          <div className="mb-1 flex items-center gap-3 text-[length:var(--text-row)] text-ink-muted">
            <span>
              done {counts.done}, failed {counts.failed}, stopped {counts.stopped}, archived{" "}
              {counts.archived}
            </span>
            {filter.state !== "finished" && (
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={finishedOpen}
                onClick={() => setShowFinished(!showFinished)}
              >
                {showFinished ? "Hide" : "Show"}
              </Button>
            )}
          </div>
          {finishedOpen && list(rows.finished)}
        </TaskSection>
      )}
      <StopTaskDialog
        open={stopId !== null}
        onOpenChange={(open) => !open && setStopId(null)}
        onConfirm={() => {
          if (stopId) actions.stop(stopId);
          setStopId(null);
        }}
      />
    </div>
  );
}
