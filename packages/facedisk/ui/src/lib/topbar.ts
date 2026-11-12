import type { Scope } from "@boof/heart/schema";

/** `runner.overview` as the UI reads it. */
export interface RunnerOverview {
  enabled: boolean;
  budgetExceeded: unknown[];
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

export type TopbarKind = "running" | "draining" | "idle" | "paused" | "blocked" | "unknown";

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
  const canStop = has(held, "tasks:write");
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
  if (o.budgetExceeded.length > 0) return "budget spent";
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
}

/**
 * Stop = pause the runner first (so the queue does not pick the next task), then stop each
 * running task. A failed pause aborts: nothing is stopped. A failed stop is listed, not thrown.
 */
export async function stopAllRunning(
  items: RunningItem[],
  pause: () => Promise<unknown>,
  stopTask: (pid: string, taskId: string) => Promise<unknown>,
): Promise<StopAllResult> {
  await pause();
  const failed: StopAllResult["failed"] = [];
  for (const item of items) {
    try {
      await stopTask(item.pid, item.taskId);
    } catch (err) {
      failed.push({ item, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { failed };
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
