import { useEffect, useMemo, useRef, useState } from "react";
import { api, type TaskView } from "../api.js";
import { Button } from "@/ui/button";
import { act } from "../lib/act.js";
import type { Route } from "../lib/route.js";
import { failedTasksVisible, groupTasks, runOrder } from "../lib/task-groups.js";
import {
  allLabels,
  filterTasks,
  listKeyAction,
  moveQueued,
  type TaskFilter,
} from "../lib/task-list.js";
import { StopTaskDialog } from "../shell/StopTaskDialog.js";
import type { AppData } from "../useAppData.js";
import { QueuedSection, type QueuedGroup } from "./QueuedSection.js";
import { EpicHeader } from "./EpicHeader.js";
import { ManageEpicsSheet } from "./ManageEpicsSheet.js";
import {
  groupTasksByEpic,
  isCollapsed,
  readCollapsed,
  readGrouping,
  reorderWithinGroup,
  writeCollapsed,
  writeGrouping,
  type EpicSection,
  type PrefStore,
} from "../lib/epic-grouping.js";
import { useFocusMode } from "../lib/useFocusMode.js";
import { useHeldScopes } from "../lib/useHeldScopes.js";
import { withEpicQuery, withQuery } from "../lib/task-links.js";
import { groupSubtasks } from "../lib/task-hierarchy.js";
import { TaskRow, type RowContext, type RowEntry } from "./TaskRow.js";
import { useEpics } from "./useEpics.js";
import { TaskSection } from "./TaskSection.js";
import { TasksToolbar } from "./TasksToolbar.js";
import { useTaskActions } from "./useTaskActions.js";

const NO_FILTER: TaskFilter = { query: "", state: "all", label: null, epic: null };
const FINISHED = new Set(["done", "failed", "stopped", "archived"]);

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

type Task = Exclude<RowEntry, { kind: "plan" }>;

const safeStorage = (): PrefStore | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** A state section's rows, split by epic when grouping is on (one group with no header otherwise). */
interface EpicGroup<E> {
  key: string;
  section: EpicSection | null;
  entries: E[];
  /** The group is folded: its header shows, its rows do not. */
  folded: boolean;
}

/** The Tasks screen: tasks grouped by what they wait for, with search, filters and the keyboard. */
export function TasksPage({
  pid,
  data,
  navigate,
  epic,
  manageEpics,
}: {
  pid: string;
  data: AppData;
  navigate: (to: Route, opts?: { replace?: boolean }) => void;
  /** The epic in the URL (`?epic=<id>`, or `none`), which the filter follows. */
  epic: string | null;
  /** `?manage=epics` is in the URL: open the Manage epics sheet. */
  manageEpics: boolean;
}) {
  const actions = useTaskActions(pid, data, navigate);
  const [filter, setFilter] = useState<TaskFilter>({ ...NO_FILTER, epic });
  useEffect(() => setFilter((f) => (f.epic === epic ? f : { ...f, epic })), [epic]);
  const focus = useFocusMode("tasks");
  const store = useMemo(safeStorage, []);
  const [grouping, setGrouping] = useState(() => readGrouping(store, pid));
  const [collapsed, setCollapsed] = useState(() => readCollapsed(store, pid));
  const [managing, setManaging] = useState(manageEpics);
  useEffect(() => {
    if (manageEpics) setManaging(true);
  }, [manageEpics]);
  const setManagingSheet = (open: boolean) => {
    setManaging(open);
    if (!open && manageEpics) {
      history.replaceState(
        null,
        "",
        withQuery(window.location.pathname, window.location.search, "manage", null),
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  };
  const held = useHeldScopes();
  useEffect(() => {
    setGrouping(readGrouping(store, pid));
    setCollapsed(readCollapsed(store, pid));
  }, [store, pid]);
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

  const epicState = useEpics(pid, tasks);
  const epics = epicState.byId;

  const rows = useMemo(() => {
    const q = filter.query.trim().toLowerCase();
    const plansShown =
      (filter.state === "all" || filter.state === "needs-you") &&
      filter.label === null &&
      filter.epic === null
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
    // Subtasks follow their parent inside a section; the queue keeps its order (it is draggable)
    // and only names the parent.
    const withHierarchy = (entries: RowEntry[], nest = true): RowEntry[] => {
      const taskEntries = entries.filter(
        (e): e is Exclude<RowEntry, { kind: "plan" }> => e.kind !== "plan",
      );
      const byTask = new Map(taskEntries.map((e) => [e.task.frontmatter.id, e]));
      const grouped = groupSubtasks(
        taskEntries.map((e) => e.task),
        { all: tasks, nest },
      ).map((h) => ({ ...byTask.get(h.task.frontmatter.id)!, hier: h }) as RowEntry);
      return [...grouped, ...entries.filter((e) => e.kind === "plan")];
    };
    const asGroups = <E extends Task>(entries: E[], nest: boolean): EpicGroup<E>[] => {
      const split = grouping
        ? groupTasksByEpic(
            entries.map((e) => e.task),
            epicState.list,
          )
        : [];
      if (!split.some((g) => g.epic !== null))
        return [
          {
            key: "all",
            section: null,
            entries: withHierarchy(entries, nest) as E[],
            folded: false,
          },
        ];
      return split.map((g) => {
        const ids = new Set(g.tasks.map((t) => t.frontmatter.id));
        return {
          key: g.key,
          section: g,
          entries: withHierarchy(
            entries.filter((e) => ids.has(e.task.frontmatter.id)),
            nest,
          ) as E[],
          folded: isCollapsed(collapsed, g),
        };
      });
    };
    const queuedGroups = asGroups(queued, false);
    const draftGroups = asGroups(
      [...groups.drafts].sort(runOrder).map((t) => task("draft", t)) as Task[],
      true,
    );
    const shownRows = <E,>(gs: EpicGroup<E>[]) => gs.flatMap((g) => (g.folded ? [] : g.entries));
    const count = <E,>(gs: EpicGroup<E>[]) => gs.reduce((n, g) => n + g.entries.length, 0);
    return {
      needs: withHierarchy(needs),
      proposed: withHierarchy(proposed),
      running: withHierarchy(groups.running.map((t) => task("running", t))),
      queued: shownRows(queuedGroups) as RowEntry[],
      queuedGroups,
      queuedCount: count(queuedGroups),
      drafts: shownRows(draftGroups) as RowEntry[],
      draftGroups,
      draftCount: count(draftGroups),
      finished: withHierarchy(finished.map((t) => task("finished", t))) as Exclude<
        RowEntry,
        { kind: "plan" }
      >[],
    };
  }, [
    groups,
    plans,
    filter,
    filtered,
    shownPending,
    queuedOrder,
    tasks,
    grouping,
    collapsed,
    epicState.list,
  ]);

  const filtering =
    filter.query.trim() !== "" ||
    filter.state !== "all" ||
    filter.label !== null ||
    filter.epic !== null;
  // The epic filter lives in the URL (the epic chip on a task page links to it): changing it
  // rewrites the query in place and the filter follows.
  const setEpic = (next: string | null) => {
    const url = withEpicQuery(window.location.pathname, window.location.search, next);
    history.replaceState(null, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const toggleGrouping = (on: boolean) => {
    setGrouping(on);
    writeGrouping(store, pid, on);
  };
  const toggleFold = (section: EpicSection) => {
    const next = { ...collapsed, [section.key]: !isCollapsed(collapsed, section) };
    setCollapsed(next);
    writeCollapsed(store, pid, next);
  };
  const failedTasks = failedTasksVisible(
    focus.expanded,
    rows.finished.map((r) => r.task),
  );
  const failedIds = new Set(failedTasks.map((t) => t.frontmatter.id));
  const failedRows = focus.expanded
    ? []
    : rows.finished.filter((r) => failedIds.has(r.task.frontmatter.id));
  const finishedHistory = rows.finished.filter((r) => !failedIds.has(r.task.frontmatter.id));
  const finishedOpen = showFinished || filtering || focus.expanded;
  const visible: RowEntry[] = [
    ...rows.needs,
    ...rows.proposed,
    ...rows.running,
    ...rows.queued,
    ...rows.drafts,
    ...(finishedOpen ? rows.finished : failedRows),
  ];
  const foldedRows = rows.queuedCount - rows.queued.length + (rows.draftCount - rows.drafts.length);
  const total = visible.length + foldedRows + (finishedOpen ? 0 : finishedHistory.length);
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
      // Focus follows the selection, so screen readers announce the row and Enter opens it.
      const el = document.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(next.key)}"]`);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: "nearest" });
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
      canReorder &&
      !e.repeat // one move per press, not one per key repeat
    ) {
      const next = moveQueued(queuedOrder, id, action === "move-up" ? -1 : 1);
      if (next) {
        reorder(next);
        // Moving the row in the DOM can drop focus from the handle; give it back.
        const el = target;
        requestAnimationFrame(() => {
          if (el?.isConnected && document.activeElement !== el) el.focus();
        });
      }
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
    tabbableKey: (selected ?? visible[0])?.key ?? null,
    onSelect: setSelectedKey,
    onStop: setStopId,
    epics,
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
      <TasksToolbar
        filter={filter}
        labels={labels}
        onFilter={setFilter}
        onNew={newTask}
        epics={epicState.list}
        onEpic={setEpic}
        grouping={grouping}
        onGrouping={toggleGrouping}
        onManageEpics={() => setManaging(true)}
        focusMode={focus.mode}
        onFocusToggle={focus.toggle}
      />
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
          <Button
            variant="outline"
            onClick={() => {
              setFilter(NO_FILTER);
              if (epic !== null) setEpic(null);
            }}
          >
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
      {rows.queuedCount > 0 && (
        <QueuedSection
          groups={rows.queuedGroups.map((g): QueuedGroup => ({
            key: g.key,
            header: g.section && (
              <EpicHeader
                section={g.section}
                shown={g.entries.length}
                collapsed={g.folded}
                onToggle={() => toggleFold(g.section!)}
              />
            ),
            entries: g.folded ? [] : g.entries,
          }))}
          ctx={ctx}
          canReorder={canReorder}
          onReorder={(group, next) => reorder(reorderWithinGroup(queuedOrder, group, next))}
        />
      )}
      {rows.draftCount > 0 && (
        <TaskSection title="Drafts" count={rows.draftCount}>
          {rows.draftGroups.map((g) => (
            <div key={g.key}>
              {g.section && (
                <EpicHeader
                  section={g.section}
                  shown={g.entries.length}
                  collapsed={g.folded}
                  onToggle={() => toggleFold(g.section!)}
                />
              )}
              {!g.folded && list(g.entries)}
            </div>
          ))}
        </TaskSection>
      )}
      {!focus.expanded && failedRows.length > 0 && (
        <TaskSection title="Failed" count={failedRows.length}>
          {list(failedRows)}
        </TaskSection>
      )}
      {finishedHistory.length > 0 && (
        <TaskSection title="Finished" count={finishedHistory.length}>
          <div className="mb-1 flex items-center gap-3 text-[length:var(--text-row)] text-ink-muted">
            <span>
              done {counts.done}, failed {counts.failed}, stopped {counts.stopped}, archived{" "}
              {counts.archived}
            </span>
            {!filtering && !focus.expanded && (
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
          {finishedOpen && list(focus.expanded ? rows.finished : finishedHistory)}
        </TaskSection>
      )}
      <ManageEpicsSheet
        open={managing}
        onOpenChange={setManagingSheet}
        pid={pid}
        epics={epicState}
        tasks={tasks}
        held={held}
        onChanged={() => void data.refresh()}
      />
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
