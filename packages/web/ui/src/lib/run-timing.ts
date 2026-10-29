import type { TaskView } from "../api.js";

export type StepRole = "planner" | "developer" | "observer" | "reviewer";

export interface StepSegment {
  role: StepRole;
  state: "done" | "current" | "upcoming";
  /** Review round, or fix-round count plus one for the developer; 1 when there is only one. */
  round: number;
  verdict: "approve" | "reject" | null;
  seconds: number | null;
}

const ROLES: StepRole[] = ["planner", "developer", "observer", "reviewer"];

/** `Date.parse(startedAt)`, or null when the task has no valid start time. */
export function startedAtMs(task: TaskView): number | null {
  const ms = Date.parse(task.frontmatter.startedAt ?? "");
  return Number.isNaN(ms) ? null : ms;
}

/** Seconds as "42s", "4m 12s" or "1h 3m". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "run 2 of 3" for a task that runs several iterations, else null. */
export function runLabel(task: TaskView): string | null {
  const { runs, completedRuns } = task.frontmatter;
  if (runs <= 1) return null;
  return `run ${Math.min(completedRuns + 1, runs)} of ${runs}`;
}

const roleOf = (label: string): StepRole | null => {
  const word = label.trim().split(/\s+/)[0]?.toLowerCase();
  return ROLES.find((r) => r === word) ?? null;
};

const verdictOf = (v: string | undefined): "approve" | "reject" | null =>
  v === "APPROVE" ? "approve" : v === "CHANGES_REQUESTED" || v === "REJECT" ? "reject" : null;

interface Entry {
  label: string;
  role: StepRole;
  ms: number | null;
}

/**
 * One segment per role for the current run (the current iteration, from the last "Planner"
 * step on). Durations need `steps`; without them (older tasks) `logHeaders`, the step headers
 * of the task log, give the order only.
 */
export function stepStrip(task: TaskView, now: number, logHeaders: string[] = []): StepSegment[] {
  const recorded = task.frontmatter.steps ?? [];
  let entries: Entry[] = (
    recorded.length > 0
      ? recorded.map((s) => ({ label: s.label, ms: Date.parse(s.at) }))
      : logHeaders.map((label) => ({ label, ms: NaN }))
  ).flatMap((e) => {
    const role = roleOf(e.label);
    return role ? [{ label: e.label, role, ms: Number.isNaN(e.ms) ? null : e.ms }] : [];
  });
  const lastPlanner = entries.map((e) => e.label).lastIndexOf("Planner");
  if (lastPlanner > 0) entries = entries.slice(lastPlanner);

  const running = task.frontmatter.status === "running";
  // A planner answering a question does not move the pipeline back.
  const moving = entries.filter((e) => !/^Planner \(answering/.test(e.label));
  const lastRole = moving.at(-1)?.role ?? (running ? "planner" : null);
  const lastIdx = lastRole ? ROLES.indexOf(lastRole) : -1;
  const maxIdx = Math.max(-1, ...entries.map((e) => ROLES.indexOf(e.role)));
  const updatedMs = Date.parse(task.frontmatter.updated ?? "");

  return ROLES.map((role, idx): StepSegment => {
    const mine = entries.filter((e) => e.role === role);
    // A role that already ran stays done during fix rounds, when the pipeline is back at the developer.
    const state =
      running && idx === lastIdx
        ? "current"
        : mine.length > 0 || idx < maxIdx
          ? "done"
          : "upcoming";
    const first = mine[0]?.ms ?? null;

    let seconds: number | null = null;
    if (state !== "upcoming" && first !== null) {
      const after = entries.slice(entries.indexOf(mine[0]) + 1);
      const next =
        after.find((e) => ROLES.indexOf(e.role) > idx) ?? after.find((e) => e.role !== role);
      let end: number | null = null;
      if (state === "current") end = now;
      else if (next?.ms != null) end = next.ms;
      else if (!running && !Number.isNaN(updatedMs)) end = updatedMs;
      if (end !== null && end >= first) seconds = Math.round((end - first) / 1000);
    }

    let round = 1;
    if (role === "developer") {
      round = 1 + mine.filter((e) => /fix round/.test(e.label)).length;
    } else if (role === "observer" || role === "reviewer") {
      const nums = mine.map((e) => Number(/round (\d+)/.exec(e.label)?.[1])).filter((n) => n > 0);
      if (nums.length > 0) round = Math.max(...nums);
      else {
        const mineReviews = (task.reviews ?? []).filter((r) => r.role === role);
        const iter = Math.max(-Infinity, ...mineReviews.map((r) => r.iteration));
        const rounds = mineReviews.filter((r) => r.iteration === iter).map((r) => r.round);
        if (rounds.length > 0) round = Math.max(...rounds);
      }
    }

    const verdict =
      role === "observer"
        ? verdictOf(task.finalVerdict?.observer)
        : role === "reviewer"
          ? verdictOf(task.finalVerdict?.reviewer)
          : null;
    return { role, state, round, verdict, seconds };
  });
}
