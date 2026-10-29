import type { PlanSummary, TaskView } from "../api.js";

export type NeedsYouItem =
  | { kind: "question"; task: TaskView }
  | { kind: "proposed"; task: TaskView }
  | { kind: "draft-plan"; plan: PlanSummary };

export interface TaskGroups {
  needsYou: NeedsYouItem[];
  running: TaskView[];
  /** Pending, not skipped, in run order. */
  queued: TaskView[];
  /** Drafts that are not "proposed" by an api or mcp client. */
  drafts: TaskView[];
  finished: {
    counts: { done: number; failed: number; stopped: number; archived: number };
    recent: TaskView[];
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byCreated = (a: { created: string }, b: { created: string }) => cmp(a.created, b.created);

function isProposed(t: TaskView): boolean {
  const kind = t.frontmatter.origin?.kind;
  return t.frontmatter.status === "draft" && (kind === "api" || kind === "mcp");
}

/** Runner order: priority descending, then updated ascending, then id ascending. */
export function runOrder(a: TaskView, b: TaskView): number {
  const fa = a.frontmatter;
  const fb = b.frontmatter;
  return fb.priority - fa.priority || cmp(fa.updated, fb.updated) || cmp(fa.id, fb.id);
}

export function groupTasks(
  tasks: TaskView[],
  plans: PlanSummary[] = [],
  opts: { recentLimit?: number } = {},
): TaskGroups {
  const recentLimit = opts.recentLimit ?? 5;
  const by = (status: string) => tasks.filter((t) => t.frontmatter.status === status);

  const questions = by("action").sort((a, b) => byCreated(a.frontmatter, b.frontmatter));
  const proposed = tasks.filter(isProposed).sort((a, b) => byCreated(a.frontmatter, b.frontmatter));
  const draftPlans = plans.filter((p) => p.status === "draft").sort(byCreated);

  const recent = tasks
    .filter((t) => ["done", "failed", "stopped"].includes(t.frontmatter.status))
    .sort((a, b) => cmp(b.frontmatter.updated, a.frontmatter.updated))
    .slice(0, Math.max(0, recentLimit));

  return {
    needsYou: [
      ...questions.map((task) => ({ kind: "question" as const, task })),
      ...proposed.map((task) => ({ kind: "proposed" as const, task })),
      ...draftPlans.map((plan) => ({ kind: "draft-plan" as const, plan })),
    ],
    running: by("running"),
    queued: by("pending")
      .filter((t) => !t.frontmatter.skip)
      .sort(runOrder),
    drafts: by("draft").filter((t) => !isProposed(t)),
    finished: {
      counts: {
        done: by("done").length,
        failed: by("failed").length,
        stopped: by("stopped").length,
        archived: by("archived").length,
      },
      recent,
    },
  };
}
