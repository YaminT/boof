import { useEffect, useMemo, useRef, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError, type Goal, type SyncReport } from "../api.js";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { act } from "../lib/act.js";
import { listKeyAction, moveQueued } from "../lib/task-list.js";
import { SortableList } from "../shell/SortableList.js";
import { planErrorLines, sortGoals } from "../lib/plan-view.js";
import { formatRoute, type Route } from "../lib/route.js";
import type { AppData } from "../useAppData.js";
import { GoalEditor } from "./GoalEditor.js";
import { GoalPanel } from "./GoalPanel.js";
import { GoalRow } from "./GoalRow.js";
import { ArchivePlanDialog, DeleteGoalDialog, ExportDialog, SyncDialog } from "./PlanDialogs.js";
import { planTaskCounts } from "../lib/plan-grouping.js";
import { PlanHeader } from "./PlanHeader.js";
import { usePlan } from "./usePlan.js";

/** One plan: header, goal list and, with a goal in the URL, the goal's panel. */
export function PlanPage({
  pid,
  planId,
  goalId,
  data,
  navigate,
}: {
  pid: string;
  planId: string;
  goalId: string | undefined;
  data: AppData;
  navigate: (to: Route, opts?: { replace?: boolean }) => void;
}) {
  const { plan, missing, failed, reload, mutate } = usePlan(pid, planId, data.planTick);
  // The panel shows the goal editor: "new" for a goal being added, else the id of the goal edited.
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [deleting, setDeleting] = useState<{ goal: Goal; dependents: string[] | null } | null>(
    null,
  );
  const [syncPreview, setSyncPreview] = useState<SyncReport | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [exported, setExported] = useState<Record<string, string> | null>(null);
  const [archiving, setArchiving] = useState(false);

  // The order while a reorder is in flight; null shows the server's order.
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [reorderErrors, setReorderErrors] = useState<string[]>([]);
  const reordering = useRef(false);
  const serverGoals = useMemo(() => (plan ? sortGoals(plan.goals) : []), [plan]);
  const goals = useMemo(() => {
    if (!localOrder) return serverGoals;
    const byId = new Map(serverGoals.map((g) => [g.id, g]));
    const ordered = localOrder.flatMap((id) => byId.get(id) ?? []);
    return ordered.length === serverGoals.length ? ordered : serverGoals;
  }, [serverGoals, localOrder]);
  const goal = goalId ? goals.find((g) => g.id === goalId) : undefined;
  const taskById = useMemo(
    () => new Map(data.tasks.map((t) => [t.frontmatter.id, t])),
    [data.tasks],
  );

  // A deleted plan, or a goal that is not in it: say so and replace the dead URL.
  useEffect(() => {
    if (!missing) return;
    toast("This plan no longer exists.");
    navigate({ name: "plans", pid }, { replace: true });
  }, [missing, navigate, pid]);
  useEffect(() => {
    if (!plan || !goalId || goal) return;
    toast("This goal no longer exists.");
    navigate({ name: "plans", pid, planId }, { replace: true });
  }, [plan, goalId, goal, navigate, pid, planId]);

  const canReorder = !!plan && plan.status !== "archived";
  const reorder = async (order: string[]) => {
    if (!plan || !canReorder || reordering.current) return;
    reordering.current = true;
    setLocalOrder(order);
    const next = await mutate(
      (p) => api.reorderGoals(pid, p, order),
      "Could not reorder",
      undefined,
      (e) => {
        if (!(e instanceof ApiError) || e.code !== "invalid_plan") return false;
        setReorderErrors(planErrorLines(e));
        return true;
      },
    );
    if (next) setReorderErrors([]);
    setLocalOrder(null);
    reordering.current = false;
  };
  // Alt+↑ / Alt+↓ inside a goal row moves it one place; the row keeps focus.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e) => {
    const target = e.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>("li[data-goal-id]");
    if (!row || !canReorder) return;
    const typing = target!.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target!.tagName);
    const dialogOpen = !!document.querySelector("[role=dialog], [role=menu]");
    const action = listKeyAction(e, typing, dialogOpen);
    if (action !== "move-up" && action !== "move-down") return;
    e.preventDefault();
    if (e.repeat) return;
    const next = moveQueued(
      goals.map((g) => g.id),
      row.dataset.goalId!,
      action === "move-up" ? -1 : 1,
    );
    if (!next) return;
    void reorder(next);
    requestAnimationFrame(() => {
      if (target?.isConnected && document.activeElement !== target) target.focus();
    });
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // Leaving the goal being edited (another goal opened, panel closed) ends the edit.
  useEffect(() => {
    if (editing && editing !== "new" && editing !== goalId) setEditing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalId]);

  if (missing) return null;
  if (!plan) {
    return failed ? (
      <div className="py-8">
        <p className="mt-0 mb-3 text-ink-muted">Could not load this plan.</p>
        <Button variant="outline" onClick={() => void reload()}>
          Try again
        </Button>
      </div>
    ) : null;
  }

  const changed = () => void data.refresh();
  const openGoal = (id: string) => navigate({ name: "plans", pid, planId, goalId: id });
  const focusSoon = (selector: string) =>
    window.setTimeout(() => document.querySelector<HTMLElement>(selector)?.focus(), 60);
  const closePanel = () => {
    const id = goalId;
    navigate({ name: "plans", pid, planId });
    if (id) focusSoon(`li[data-goal-id="${CSS.escape(id)}"] a`);
  };
  const taskRoute = (id: string, view: "edit" | "changes" = "edit"): Route => ({
    name: "task",
    pid,
    taskId: id,
    view,
  });

  const startSync = async () => {
    const report = await act(() => api.syncPlan(pid, plan.id, true), {
      failure: "Could not preview the sync",
    });
    if (report) setSyncPreview(report);
  };
  const confirmSync = async () => {
    setSyncing(true);
    const r = await act(() => api.syncPlan(pid, plan.id, false), { failure: "Could not sync" });
    setSyncing(false);
    setSyncPreview(null);
    if (!r) return;
    toast.success(`Synced: ${r.created.length} created, ${r.updated.length} updated`);
    void reload();
    changed();
  };
  const removeGoal = async (cascade: boolean) => {
    if (!deleting) return;
    const g = deleting.goal;
    const next = await mutate(
      (p) => api.deleteGoal(pid, p, g.id, cascade),
      "Could not delete the goal",
      undefined,
      (e) => {
        if (!(e instanceof ApiError) || e.code !== "goal_has_dependents") return false;
        const ids = (e.details as { dependents?: string[] } | undefined)?.dependents ?? [];
        setDeleting({
          goal: g,
          dependents: ids.map((id) => goals.find((x) => x.id === id)?.title ?? id),
        });
        return true;
      },
    );
    if (next) {
      setDeleting(null);
      if (goalId === g.id) closePanel();
      changed();
    }
  };

  return (
    <div className="flex max-w-[1320px] flex-col">
      <PlanHeader
        pid={pid}
        plan={plan}
        busy={false}
        taskCounts={planTaskCounts(data.tasks, plan.id)}
        onActivate={() =>
          void mutate((p) => api.updatePlan(pid, p, { status: "active" }), "Could not activate")
        }
        onSync={() => void startSync()}
        onAddGoal={() => {
          setEditing("new");
          if (goalId) closePanel();
        }}
        onAutoSync={(on) =>
          void mutate((p) => api.updatePlan(pid, p, { autoSync: on }), "Could not change auto-sync")
        }
        onBumpTo={(v) =>
          void mutate((p) => api.updatePlan(pid, p, { bumpTo: v }), "Could not change the bump")
        }
        onExport={() =>
          void act(() => api.exportPlan(pid, plan.id), { failure: "Could not export" }).then(
            (f) => f && setExported(f),
          )
        }
        onArchive={() => setArchiving(true)}
      />
      <div className="flex flex-col gap-6 min-[1024px]:flex-row min-[1024px]:items-start">
        <div className={`min-w-0 flex-1 ${goal || editing ? "hidden min-[1024px]:block" : ""}`}>
          {goals.length >= 2 && canReorder && (
            <p className="m-0 mb-1 text-[length:var(--text-meta)] text-ink-muted">
              Drag or press Alt+↑ ↓ to reorder
            </p>
          )}
          {reorderErrors.length > 0 && (
            <div
              role="alert"
              className="mb-2 flex flex-col gap-1 rounded-md border border-failed/40 bg-surface px-3 py-2 text-[length:var(--text-row)] text-failed"
            >
              {reorderErrors.map((m, i) => (
                <span key={i}>{m}</span>
              ))}
              <Button
                variant="ghost"
                size="xs"
                className="self-start"
                onClick={() => setReorderErrors([])}
              >
                Dismiss
              </Button>
            </div>
          )}
          {goals.length === 0 ? (
            <p className="m-0 py-6 text-ink-muted">This plan has no goals yet. Add one.</p>
          ) : (
            <SortableList
              ids={goals.map((g) => g.id)}
              disabled={!canReorder}
              labelFor={(id) => goals.find((g) => g.id === id)?.title ?? id}
              onReorder={(order) => void reorder(order)}
            >
              {(id, handle, row) => {
                const g = goals.find((x) => x.id === id);
                if (!g) return null;
                const index = goals.indexOf(g);
                const task = g.taskId ? taskById.get(g.taskId) : undefined;
                const tf = task?.frontmatter;
                const ids = goals.map((x) => x.id);
                return (
                  <GoalRow
                    key={g.id}
                    goal={g}
                    goals={goals}
                    task={task}
                    taskHref={task ? formatRoute(taskRoute(task.frontmatter.id)) : null}
                    selected={g.id === goalId}
                    handle={handle}
                    rowRef={row.rowRef}
                    style={row.style}
                    onOpen={() => openGoal(g.id)}
                    onStatus={(s) =>
                      void mutate(
                        (p) => api.setGoalStatus(pid, p, g.id, s),
                        "Could not change the status",
                      )
                    }
                    menu={
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          aria-label={`More actions for ${g.title}`}
                          className="inline-flex size-7 items-center justify-center rounded-md text-ink-muted outline-none hover:bg-accent hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          <EllipsisIcon className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onClick={() => openGoal(g.id)}>
                            Open goal
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              setEditing(g.id);
                              if (g.id !== goalId) openGoal(g.id);
                            }}
                          >
                            Edit goal
                          </DropdownMenuItem>
                          {canReorder && (
                            <>
                              <DropdownMenuItem
                                disabled={index === 0}
                                onClick={() => {
                                  const n = moveQueued(ids, g.id, -1);
                                  if (n) void reorder(n);
                                }}
                              >
                                Move up
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={index === goals.length - 1}
                                onClick={() => {
                                  const n = moveQueued(ids, g.id, 1);
                                  if (n) void reorder(n);
                                }}
                              >
                                Move down
                              </DropdownMenuItem>
                            </>
                          )}
                          {task && (
                            <DropdownMenuItem
                              onClick={() => navigate(taskRoute(task.frontmatter.id))}
                            >
                              Open task
                            </DropdownMenuItem>
                          )}
                          {task && (tf?.status === "done" || tf?.status === "failed") && (
                            <DropdownMenuItem
                              onClick={() => navigate(taskRoute(task.frontmatter.id, "changes"))}
                            >
                              Open changes
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => setDeleting({ goal: g, dependents: null })}
                          >
                            Delete goal…
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    }
                  />
                );
              }}
            </SortableList>
          )}
          <Button
            variant="outline"
            size="sm"
            data-add-goal
            className="mt-3"
            onClick={() => {
              setEditing("new");
              if (goalId) closePanel();
            }}
          >
            Add goal
          </Button>
        </div>
        {editing ? (
          <div className="w-full shrink-0 rounded-lg border border-line bg-surface p-4 min-[1024px]:w-[400px]">
            <GoalEditor
              key={editing}
              pid={pid}
              plan={plan}
              goal={editing === "new" ? null : (plan.goals.find((g) => g.id === editing) ?? null)}
              onCancel={() => {
                setEditing(null);
                focusSoon(editing === "new" ? "[data-add-goal]" : "[data-edit-goal]");
              }}
              onSaved={async (id) => {
                setEditing(null);
                if (id === goalId) focusSoon("[data-edit-goal]");
                // The plan must hold the goal before its URL does, or the URL is "corrected" away.
                await reload();
                changed();
                if (id !== goalId) openGoal(id);
              }}
            />
          </div>
        ) : (
          goal && (
            <GoalPanel
              pid={pid}
              plan={plan}
              goal={goal}
              tasks={taskById}
              onEdit={() => setEditing(goal.id)}
              onSync={() => void startSync()}
              onClose={closePanel}
            />
          )
        )}
      </div>

      <SyncDialog
        report={syncPreview}
        busy={syncing}
        onConfirm={() => void confirmSync()}
        onClose={() => setSyncPreview(null)}
      />
      <ExportDialog files={exported} onClose={() => setExported(null)} />
      <ArchivePlanDialog
        open={archiving}
        onOpenChange={setArchiving}
        onConfirm={() => {
          setArchiving(false);
          void mutate(
            (p) => api.updatePlan(pid, p, { status: "archived" }),
            "Could not archive",
          ).then((n) => n && changed());
        }}
      />
      <DeleteGoalDialog
        goal={deleting?.goal ?? null}
        dependents={deleting?.dependents ?? null}
        onClose={() => setDeleting(null)}
        onConfirm={(cascade) => void removeGoal(cascade)}
      />
    </div>
  );
}
