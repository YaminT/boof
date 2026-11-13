import type { Plan, PlanSummary, TaskView } from "../api.js";
import type { EpicSection } from "./epic-grouping.js";
import { formatRoute } from "./route.js";

/** How the Tasks list is split into groups. */
export type GroupBy = "none" | "epic" | "plan";

export const GROUP_BY_LABELS: Record<GroupBy, string> = {
  none: "None",
  epic: "Epic",
  plan: "Plan",
};

export const NO_PLAN_LABEL = "Not in a plan";

/** The plan goal a task was created from, if any. */
export function planRefOf(task: TaskView): { planId: string; goalId: string } | null {
  const ref = task.frontmatter.planRef;
  return ref ? { planId: ref.planId, goalId: ref.goalId } : null;
}

/** App-relative link to the Tasks list grouped by plan. */
export function tasksByPlanHref(pid: string): string {
  return `${formatRoute({ name: "tasks", pid })}?group=plan`;
}

/** Whether a Tasks URL's query asks for the plan grouping. */
export const groupFromSearch = (search: string): GroupBy | null => {
  const v = new URLSearchParams(search).get("group");
  return v === "plan" || v === "epic" || v === "none" ? v : null;
};

export interface PlanTaskCounts {
  total: number;
  done: number;
  running: number;
  /** Not started yet: pending, draft or waiting for an answer. */
  waiting: number;
}

/** What a plan's tasks are doing now; archived tasks are not counted. */
export function planTaskCounts(tasks: TaskView[], planId: string): PlanTaskCounts {
  const c: PlanTaskCounts = { total: 0, done: 0, running: 0, waiting: 0 };
  for (const t of tasks) {
    if (planRefOf(t)?.planId !== planId) continue;
    const s = t.frontmatter.status;
    if (s === "archived") continue;
    c.total++;
    if (s === "done") c.done++;
    else if (s === "running") c.running++;
    else if (s === "pending" || s === "draft" || s === "action") c.waiting++;
  }
  return c;
}

/** "3 tasks: 1 done, 1 running, 1 waiting"; zero parts are left out, none at all is "No tasks yet". */
export function planCountsLabel(c: PlanTaskCounts): string {
  if (c.total === 0) return "No tasks yet";
  const parts = [
    c.done && `${c.done} done`,
    c.running && `${c.running} running`,
    c.waiting && `${c.waiting} waiting`,
  ].filter(Boolean);
  return `${c.total} ${c.total === 1 ? "task" : "tasks"}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

/** The goal's title and place in its plan; falls back to the goal id while the plan is loading. */
export function goalInfo(
  plan: Pick<Plan, "goals"> | undefined,
  goalId: string,
): { title: string; n: number; m: number } | null {
  if (!plan) return null;
  const i = plan.goals.findIndex((g) => g.id === goalId);
  return i < 0 ? null : { title: plan.goals[i]!.title, n: i + 1, m: plan.goals.length };
}

export interface PlanChip {
  label: string;
  href: string;
  planId: string;
  goalId: string;
}

/** `Plan: <title> › <goal>` for a plan task, linking to the goal; null for other tasks. */
export function planChip(
  pid: string,
  task: TaskView,
  plans: ReadonlyMap<string, Pick<PlanSummary, "title">>,
  details: ReadonlyMap<string, Plan>,
): PlanChip | null {
  const ref = planRefOf(task);
  if (!ref) return null;
  const title = plans.get(ref.planId)?.title ?? ref.planId;
  const goal = goalInfo(details.get(ref.planId), ref.goalId)?.title ?? ref.goalId;
  return {
    label: `Plan: ${title} › ${goal}`,
    href: formatRoute({ name: "plans", pid, planId: ref.planId, goalId: ref.goalId }),
    planId: ref.planId,
    goalId: ref.goalId,
  };
}

/**
 * Splits tasks by plan, in the plans' own order (oldest first); tasks without a plan, or whose
 * plan no longer exists, go last under "Not in a plan". Inside a group tasks follow the plan's
 * goal order when the plan is loaded, and keep their order otherwise. The group's progress counts
 * all of the plan's tasks, not only those shown.
 */
export function groupTasksByPlan(
  tasks: TaskView[],
  plans: PlanSummary[],
  all: TaskView[] = tasks,
  details: ReadonlyMap<string, Pick<Plan, "goals">> = new Map(),
): EpicSection[] {
  const known = new Map(plans.map((p) => [p.id, p]));
  const buckets = new Map<string, TaskView[]>();
  for (const t of tasks) {
    const id = planRefOf(t)?.planId;
    const key = id && known.has(id) ? `plan:${id}` : "none";
    buckets.set(key, [...(buckets.get(key) ?? []), t]);
  }
  const out: EpicSection[] = [];
  const ordered = [...plans].sort(
    (a, b) =>
      (a.created < b.created ? -1 : a.created > b.created ? 1 : 0) || a.id.localeCompare(b.id),
  );
  for (const p of ordered) {
    const rows = buckets.get(`plan:${p.id}`);
    if (!rows) continue;
    const goals = details.get(p.id)?.goals;
    const at = (t: TaskView) => {
      const i = goals?.findIndex((g) => g.id === planRefOf(t)?.goalId) ?? -1;
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const c = planTaskCounts(all, p.id);
    out.push({
      key: `plan:${p.id}`,
      epic: null,
      label: p.title,
      tasks: goals ? [...rows].sort((a, b) => at(a) - at(b)) : rows,
      progress: c.total ? { done: c.done, total: c.total } : null,
      archived: p.status === "archived",
    });
  }
  const rest = buckets.get("none");
  if (rest)
    out.push({
      key: "none",
      epic: null,
      label: NO_PLAN_LABEL,
      tasks: rest,
      progress: null,
      archived: false,
    });
  return out;
}

/**
 * Titles of the goals a blocked task still waits for (its goal's unfinished dependencies), or
 * null when the task is not a blocked plan task or the plan is not loaded.
 */
export function waitingFor(
  task: Pick<TaskView, "frontmatter">,
  plan: Pick<Plan, "goals"> | undefined,
): string[] | null {
  const ref = task.frontmatter.planRef;
  if (!ref || !plan || !task.frontmatter.labels.includes("blocked")) return null;
  const goal = plan.goals.find((g) => g.id === ref.goalId);
  if (!goal) return null;
  const titles = goal.dependsOn.flatMap((d) => {
    const dep = plan.goals.find((g) => g.id === d);
    return dep && dep.status === "done" ? [] : [dep?.title ?? d];
  });
  return titles.length > 0 ? titles : null;
}
