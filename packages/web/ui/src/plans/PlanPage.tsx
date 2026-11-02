import { useEffect, useMemo, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError, type Goal, type GoalInput, type SyncReport } from "../api.js";
import { Button } from "@/ui/button";
import { GoalForm } from "../components/GoalForm.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { act } from "../lib/act.js";
import { planErrorLines, sortGoals } from "../lib/plan-view.js";
import { formatRoute, type Route } from "../lib/route.js";
import type { AppData } from "../useAppData.js";
import { GoalPanel } from "./GoalPanel.js";
import { GoalRow } from "./GoalRow.js";
import { ArchivePlanDialog, DeleteGoalDialog, ExportDialog, SyncDialog } from "./PlanDialogs.js";
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
  const [editing, setEditing] = useState<Goal | "new" | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<{ goal: Goal; dependents: string[] | null } | null>(
    null,
  );
  const [syncPreview, setSyncPreview] = useState<SyncReport | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [exported, setExported] = useState<Record<string, string> | null>(null);
  const [archiving, setArchiving] = useState(false);

  const goals = useMemo(() => (plan ? sortGoals(plan.goals) : []), [plan]);
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
  const closePanel = () => navigate({ name: "plans", pid, planId });
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
  const saveGoal = async (g: GoalInput) => {
    setFormErrors([]);
    try {
      await api.putGoal(pid, plan, g);
      setEditing(null);
      await reload();
      changed();
    } catch (e) {
      setFormErrors(planErrorLines(e));
    }
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
        onActivate={() =>
          void mutate((p) => api.updatePlan(pid, p, { status: "active" }), "Could not activate")
        }
        onSync={() => void startSync()}
        onAddGoal={() => {
          setFormErrors([]);
          setEditing("new");
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
        <div className={`min-w-0 flex-1 ${goal ? "hidden min-[1024px]:block" : ""}`}>
          {goals.length === 0 ? (
            <p className="m-0 py-6 text-ink-muted">This plan has no goals yet. Add one.</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {goals.map((g) => {
                const task = g.taskId ? taskById.get(g.taskId) : undefined;
                const tf = task?.frontmatter;
                return (
                  <GoalRow
                    key={g.id}
                    goal={g}
                    goals={goals}
                    task={task}
                    taskHref={task ? formatRoute(taskRoute(task.frontmatter.id)) : null}
                    selected={g.id === goalId}
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
                              setFormErrors([]);
                              setEditing(g);
                            }}
                          >
                            Edit goal
                          </DropdownMenuItem>
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
              })}
            </ul>
          )}
        </div>
        {goal && <GoalPanel goal={goal} onClose={closePanel} />}
      </div>

      {editing && (
        <GoalForm
          goal={editing === "new" ? null : editing}
          others={goals.filter((g) => editing === "new" || g.id !== editing.id).map((g) => g.id)}
          error={formErrors}
          onSave={(g) => void saveGoal(g)}
          onClose={() => setEditing(null)}
        />
      )}
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
