import type { Scope } from "@boof/heart/schema";

/** `runner.overview` as the UI reads it. */
export interface RunnerOverview {
  enabled: boolean;
  budgetExceeded: unknown[];
  /** The account pool; absent without one. */
  pool?: {
    status?: string;
    routable?: number | null;
    usageExhausted?: number | null;
    nextAvailableAt?: string | null;
  } | null;
  projects: { id: string; paused: boolean; running: string[]; counts: Record<string, number> }[];
}

/** One running task, ready to show. */
export interface RunningItem {
  pid: string;
  project: string;
  taskId: string;
  title: string;
  plan?: string;
}

export type TopbarKind =
  "running" | "draining" | "idle" | "waiting" | "paused" | "blocked" | "unknown";

export interface TopbarState {
  kind: TopbarKind;
  /** The state word is always the first word, so colour is never the only signal. */
  text: string;
  /** Show Pause (runner on) or Start (runner paused or blocked); null hides the button. */
  toggle: null | { label: "Pause" | "Start"; disabled: boolean; reason?: string };
  stop: boolean;
  running: RunningItem[];
}

export interface TopbarInput {
  /** Null when the key may not read it (or it has not loaded yet). */
  overview: RunnerOverview | null;
  /** Running tasks of the selected project, the fallback when `overview` is null. */
  fallbackRunning: RunningItem[];
  /** Titles for the ids the overview lists, by `pid/taskId`. */
  items: ReadonlyMap<string, RunningItem>;
  held: ReadonlySet<Scope> | "all";
  /** The step of the first running task, if known. */
  step?: string | null;
  /** True when no harness is installed (wired in by a later task). */
  noHarness?: boolean;
  /** When the spent budget or the exhausted pool frees up again (ISO), if known. */
  resetAt?: string | null;
  /** Time zone for "resumes at HH:MM"; the browser's when absent. */
  timeZone?: string;
}

/** "14:05" in the given (or the local) time zone; null for a missing or bad date. */
export function formatResumeTime(iso: string | null | undefined, timeZone?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  });
}

/** True when the daily budget is spent or every pool account hit its usage limit. */
export function waitingForReset(o: RunnerOverview): boolean {
  const pool = o.pool;
  return (
    o.budgetExceeded.length > 0 || (!!pool && (pool.usageExhausted ?? 0) > 0 && pool.routable === 0)
  );
}

/** The time the overview itself knows about (the pool's); the budget's comes from the budget API. */
export function poolResetAt(o: RunnerOverview): string | null {
  return o.pool?.nextAvailableAt ?? null;
}

const has = (held: ReadonlySet<Scope> | "all", scope: Scope) =>
  held === "all" || held.has("admin") || held.has(scope);

/** "Plan › Task" (the plan part only when the task has one). */
export function itemLabel(i: RunningItem): string {
  return i.plan ? `${i.plan} › ${i.title}` : i.title;
}

/** What the topbar shows, from the runner overview and the key's scopes. */
export function topbarState(input: TopbarInput): TopbarState {
  const { overview, held } = input;
  const canControl = has(held, "runner:control") || has(held, "settings:write");
  const canStop = has(held, "tasks:write") || has(held, "tasks:control");
  if (!overview) {
    // No global state: only the selected project's tasks are known, and nothing can be toggled.
    const running = input.fallbackRunning;
    return {
      kind: running.length > 0 ? "running" : "unknown",
      text: runningText(running, input.step),
      toggle: null,
      stop: running.length > 0 && canStop,
      running,
    };
  }
  const running: RunningItem[] = [];
  let queued = 0;
  for (const p of overview.projects) {
    queued += p.counts.pending ?? 0;
    for (const id of p.running) {
      running.push(
        input.items.get(`${p.id}/${id}`) ?? { pid: p.id, project: p.id, taskId: id, title: id },
      );
    }
  }
  const stop = running.length > 0 && canStop;
  const toggle = (label: "Pause" | "Start", reason?: string) =>
    canControl ? { label, disabled: !!reason, ...(reason ? { reason } : {}) } : null;
  if (!overview.enabled) {
    if (running.length > 0) {
      const one = running.length === 1 ? itemLabel(running[0]) : `${running.length} tasks`;
      return {
        kind: "draining",
        text: `Paused · finishing ${one}`,
        toggle: toggle("Start"),
        stop,
        running,
      };
    }
    return {
      kind: "paused",
      text: `Paused · ${queued} queued`,
      toggle: toggle("Start"),
      stop: false,
      running,
    };
  }
  if (running.length === 0 && !input.noHarness && waitingForReset(overview)) {
    const at = formatResumeTime(input.resetAt ?? poolResetAt(overview), input.timeZone);
    return {
      kind: "waiting",
      text: `Waiting for usage-limit reset${at ? `, resumes at ${at}` : ""}`,
      toggle: toggle("Pause"),
      stop: false,
      running,
    };
  }
  const reason = blockedReason(overview, input.noHarness === true);
  if (reason && running.length === 0) {
    return {
      kind: "blocked",
      text: `Cannot run: ${reason}`,
      toggle: toggle("Start", reason),
      stop: false,
      running,
    };
  }
  if (running.length > 0) {
    return {
      kind: "running",
      text: runningText(running, input.step),
      toggle: toggle("Pause"),
      stop,
      running,
    };
  }
  return {
    kind: "idle",
    text: `Runner on · waiting · ${queued} queued`,
    toggle: toggle("Pause"),
    stop: false,
    running,
  };
}

function blockedReason(o: RunnerOverview, noHarness: boolean): string | null {
  if (noHarness) return "no harness installed";
  if (o.projects.length > 0 && o.projects.every((p) => p.paused)) return "all projects paused";
  return null;
}

function runningText(running: RunningItem[], step?: string | null): string {
  if (running.length === 0) return "Runner status unavailable";
  if (running.length > 1) return `Running ${running.length} tasks`;
  const [one] = running;
  return `Running · ${itemLabel(one)}${step ? ` · ${step}` : ""}`;
}

export interface StopAllResult {
  /** Tasks that did not stop, with the server's message. */
  failed: { item: RunningItem; message: string }[];
  /** Set when the pause was refused (a key without the right to pause); the tasks were still stopped. */
  pauseFailed?: string;
}

/**
 * Stop = pause the runner first (so the queue does not pick the next task), then stop each
 * running task. A refused pause (a key with `tasks:control` but no right to pause) does not
 * block the stops: the tasks are stopped and the result says the runner was not paused. A failed
 * stop is listed, not thrown.
 */
export async function stopAllRunning(
  items: RunningItem[],
  pause: () => Promise<unknown>,
  stopTask: (pid: string, taskId: string) => Promise<unknown>,
): Promise<StopAllResult> {
  let pauseFailed: string | undefined;
  try {
    await pause();
  } catch (err) {
    pauseFailed = err instanceof Error ? err.message : String(err);
  }
  const failed: StopAllResult["failed"] = [];
  for (const item of items) {
    try {
      await stopTask(item.pid, item.taskId);
    } catch (err) {
      failed.push({ item, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { failed, ...(pauseFailed !== undefined ? { pauseFailed } : {}) };
}

/** "Stop N running tasks and pause the runner?" in the dialog's words. */
export function stopSummary(items: RunningItem[]): string {
  return items.length === 1
    ? "Stop 1 running task and pause the runner? Its worktree is kept."
    : `Stop ${items.length} running tasks and pause the runner? Worktrees are kept.`;
}

/** WCAG contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export interface NextStepInput {
  kind: TopbarKind;
  queued: number;
  tasks: { status: string }[];
  plans: { title: string; status?: string; goalCount: number; doneCount: number }[];
}

export type NextStep = { to: "tasks" | "wizard" | "plans"; text: string; link: string } | null;

/**
 * What to do when the runner has nothing to run: queue the drafts, plan the next piece after a
 * finished plan, or plan from scratch. Null while work runs, waits for a reset or is queued.
 */
export function nextStep(input: NextStepInput): NextStep {
  if (input.kind !== "idle" && input.kind !== "paused") return null;
  if (input.queued > 0) return null;
  const drafts = input.tasks.filter((t) => t.status === "draft").length;
  if (drafts > 0)
    return {
      to: "tasks",
      text: `${drafts} draft ${drafts === 1 ? "task" : "tasks"} not queued yet`,
      link: "Review and queue",
    };
  const finished = input.plans.find(
    (p) => p.status !== "archived" && p.goalCount > 0 && p.doneCount >= p.goalCount,
  );
  if (finished)
    return {
      to: "wizard",
      text: `Plan "${finished.title}" is finished`,
      link: "Plan the next step",
    };
  if (!input.tasks.some((t) => ["pending", "running", "action"].includes(t.status)))
    return { to: "wizard", text: "Nothing queued", link: "Plan what's next" };
  return null;
}
