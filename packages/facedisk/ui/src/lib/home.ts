import type { Project } from "@boof/heart/schema";
import type { RunnerOverview } from "./topbar.js";
import { relativeTime } from "./time.js";

type OverviewProject = RunnerOverview["projects"][number];

export type CardState = "needs-you" | "blocked" | "running" | "paused" | "idle";

export interface HomeCard {
  project: Project;
  state: CardState;
  /** "Needs you: 2", "Running", "Paused", "Idle", "Blocked". */
  stateLabel: string;
  running: string[];
  needsYou: number;
  queued: number;
  done: number;
  total: number;
  /** 0..100, whole percent; 0 when there is nothing to do. */
  percent: number;
  progressText: string;
  planTitle: string | null;
  goalsText: string | null;
  /** The branch that holds the finished work when the plan is done; null otherwise. */
  finishedBranch: string | null;
  lastActivity: string | null;
  activityText: string | null;
  doneToday: number;
}

const n = (counts: Record<string, number>, key: string) => counts[key] ?? 0;

/** Progress: done / (done + running + queued + needs you + failed); "0 of 0" is handled. */
export function progressOf(counts: Record<string, number>): {
  done: number;
  total: number;
  percent: number;
  text: string;
} {
  const done = n(counts, "done");
  const total =
    done + n(counts, "running") + n(counts, "pending") + n(counts, "action") + n(counts, "failed");
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const text = total === 0 ? "No tasks yet" : `${done} of ${total} tasks done`;
  return { done, total, percent, text };
}

/** A failure counts as blocking for this long after the task failed. */
export const FAILURE_BLOCKS_MS = 24 * 3_600_000;

export function stateOf(
  row: Pick<OverviewProject, "paused" | "running" | "counts" | "lastFailure"> | undefined,
  now: number = Date.now(),
): {
  state: CardState;
  label: string;
} {
  if (!row) return { state: "idle", label: "Idle" };
  const needs = n(row.counts, "action");
  if (needs > 0) return { state: "needs-you", label: `Needs you: ${needs}` };
  if (row.running.length > 0) return { state: "running", label: "Running" };
  // Blocked: a failure that is still current and nothing queued to carry on. An old failed task
  // left in the folder, or one the runner has queued work past, is not a block.
  const failedAt = row.lastFailure ? Date.parse(row.lastFailure) : NaN;
  const current = row.lastFailure === undefined || !(now - failedAt > FAILURE_BLOCKS_MS);
  if (n(row.counts, "failed") > 0 && n(row.counts, "pending") === 0 && current && !row.paused)
    return { state: "blocked", label: "Blocked" };
  if (row.paused) return { state: "paused", label: "Paused" };
  return { state: "idle", label: "Idle" };
}

const RANK: Record<CardState, number> = {
  "needs-you": 0,
  blocked: 2,
  running: 1,
  paused: 3,
  idle: 3,
};

/** Cards for `projects`, ordered: needs you, running, blocked, then the newest activity. */
export function homeCards(
  projects: readonly Project[],
  overview: RunnerOverview | null,
  now: number = Date.now(),
): HomeCard[] {
  const cards = projects.map((project): HomeCard => {
    const row = overview?.projects.find((p) => p.id === project.id);
    const counts = row?.counts ?? {};
    const { state, label } = project.archived
      ? { state: "idle" as const, label: "Archived" }
      : stateOf(row, now);
    const progress = progressOf(counts);
    const plans = row?.plans;
    const last = row?.lastActivity ?? null;
    const when = last ? relativeTime(last, now) : "";
    return {
      project,
      state,
      stateLabel: label,
      running: row?.running ?? [],
      needsYou: n(counts, "action"),
      queued: n(counts, "pending"),
      done: progress.done,
      total: progress.total,
      percent: progress.percent,
      progressText: progress.text,
      planTitle: plans?.activeTitle ?? null,
      goalsText:
        plans?.activeTitle && plans.goalsTotal > 0
          ? `${plans.goalsDone} of ${plans.goalsTotal} goals done`
          : null,
      finishedBranch: plans?.finishedBranch ?? null,
      lastActivity: last,
      activityText: when ? (when === "just now" ? "active just now" : `active ${when}`) : null,
      doneToday: row?.doneToday ?? 0,
    };
  });
  return cards.sort(
    (a, b) =>
      RANK[a.state] - RANK[b.state] ||
      (Date.parse(b.lastActivity ?? "") || 0) - (Date.parse(a.lastActivity ?? "") || 0) ||
      a.project.name.localeCompare(b.project.name),
  );
}

export interface HomeSummary {
  running: number;
  queued: number;
  needsYou: number;
  doneToday: number;
}

export function summaryOf(cards: readonly HomeCard[]): HomeSummary {
  return cards.reduce<HomeSummary>(
    (s, c) => ({
      running: s.running + c.running.length,
      queued: s.queued + c.queued,
      needsYou: s.needsYou + c.needsYou,
      doneToday: s.doneToday + c.doneToday,
    }),
    { running: 0, queued: 0, needsYou: 0, doneToday: 0 },
  );
}

/** Above this many projects the list gets a filter box. */
export const FILTER_FROM = 8;

export function filterCards(cards: readonly HomeCard[], query: string): HomeCard[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...cards];
  return cards.filter((c) =>
    [c.project.name, c.project.id, c.project.workingDirectory, c.project.brief ?? ""].some((v) =>
      v.toLowerCase().includes(q),
    ),
  );
}
