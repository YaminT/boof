import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bell,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleCheck,
  Clock,
  Eye,
  Hammer,
  Pause,
  PencilRuler,
  Play,
  Square,
  TriangleAlert,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Project } from "@boof/heart/schema";
import { api, type TaskView } from "../api.js";
import type { AppData } from "../useAppData.js";
import { act, errorMessage } from "../lib/act.js";
import { formatRoute } from "../lib/route.js";
import { useHeldScopes } from "../lib/useHeldScopes.js";
import type { RunnerOverviewState } from "../lib/runner-overview-context.js";
import { setRunner } from "../lib/runner-toggle.js";
import type { HarnessesState } from "../useHarnesses.js";
import { useRunningStep } from "../lib/useRunningStep.js";
import {
  itemLabel,
  nextStep,
  pendingCount,
  stopAllRunning,
  waitingForReset,
  stopSummary,
  topbarState,
  type RunningItem,
  type TopbarState,
  type TopbarTone,
} from "../lib/topbar.js";
import {
  EMPTY_FINISHED,
  FINISHED_TTL_MS,
  stepFinished,
  withFinished,
  type FinishedMemory,
} from "../lib/finished.js";
import { ConnectionIndicator } from "./ConnectionIndicator.js";
import { announcementOf } from "../lib/topbar-announce.js";
import { StopTaskDialog } from "./StopTaskDialog.js";
import { toast } from "sonner";

/** Titles of tasks in projects other than the selected one, fetched once per id. */
const otherTitles = new Map<string, TaskView | null>();

const TONE_ICON: Record<TopbarTone, LucideIcon> = {
  idle: Circle,
  paused: Pause,
  planning: PencilRuler,
  working: Hammer,
  reviewing: Eye,
  finished: CircleCheck,
  blocked: TriangleAlert,
  waiting: Clock,
};

/** Tasks done of the active plan of the first running task (the selected project's), if any. */
function planProgress(data: AppData, state: TopbarState): { done: number; total: number } | null {
  const first = state.running[0];
  const task = first ? data.tasks.find((t) => t.frontmatter.id === first.taskId) : undefined;
  const plan = data.plans.find((p) => p.id === task?.frontmatter.planRef?.planId);
  return plan && plan.goalCount > 0 ? { done: plan.doneCount, total: plan.goalCount } : null;
}

/** The state word (bold) and the rest of the text, with its separator ("· x", ": x" or " x"). */
function splitStateWord(text: string): [string, string] {
  const m = /^(.+?)( · |: )(.*)$/.exec(text);
  if (m) return [m[1], m[2] === ": " ? `: ${m[3]}` : ` · ${m[3]}`];
  const i = text.indexOf(" ");
  return i < 0 ? [text, ""] : [text.slice(0, i), text.slice(i)];
}

/** A bar control: an icon with an accessible name and a tooltip (the title). */
function IconBtn({
  label,
  title,
  disabled,
  expanded,
  onClick,
  children,
}: {
  label: string;
  title: string;
  disabled?: boolean;
  expanded?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="topbar-btn"
      aria-label={label}
      title={title}
      disabled={disabled}
      {...(expanded !== undefined ? { "aria-expanded": expanded } : {})}
      onClick={onClick}
    >
      <span aria-hidden className="contents">
        {children}
      </span>
    </button>
  );
}

/** One bar above every screen: what the runner does, and Pause, Start and Stop. */
export function TopBar({
  runner,
  data,
  projects,
  selected,
  needsYou,
  harnesses,
}: {
  runner: RunnerOverviewState;
  data: AppData;
  projects: Project[] | null;
  selected: Project | null;
  needsYou: number;
  harnesses: HarnessesState;
}) {
  const held = useHeldScopes();
  const { overview, denied, stale, reload } = runner;
  const [budgetReset, setBudgetReset] = useState<string | null>(null);
  const [, bump] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState(false);
  const pid = selected?.id ?? null;
  const projectName = (id: string) => projects?.find((p) => p.id === id)?.name ?? id;

  // Fetch titles for running tasks that are not in the selected project's list.
  const ids = overview?.projects.flatMap((p) => p.running.map((t) => `${p.id}/${t}`)) ?? [];
  const idKey = ids.join("\n");
  useEffect(() => {
    let live = true;
    for (const key of idKey ? idKey.split("\n") : []) {
      const [p, t] = key.split("/");
      if (p === pid || otherTitles.has(key)) continue;
      otherTitles.set(key, null);
      api.getTask(p, t).then(
        (task) => {
          otherTitles.set(key, task);
          if (live) bump((n) => n + 1);
        },
        () => otherTitles.delete(key),
      );
    }
    return () => {
      live = false;
    };
  }, [idKey, pid]);

  const planTitle = (planId?: string) => data.plans.find((p) => p.id === planId)?.title;
  const items = useMemo(() => {
    const map = new Map<string, RunningItem>();
    for (const key of idKey ? idKey.split("\n") : []) {
      const [p, t] = key.split("/");
      const task =
        p === pid ? data.tasks.find((x) => x.frontmatter.id === t) : (otherTitles.get(key) ?? null);
      if (!task) continue;
      const plan = p === pid ? planTitle(task.frontmatter.planRef?.planId) : undefined;
      map.set(key, {
        pid: p,
        project: projectName(p),
        taskId: t,
        title: task.frontmatter.title,
        ...(plan ? { plan } : {}),
      });
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey, pid, data.tasks, data.plans, projects, otherTitles.size]);

  const fallbackRunning: RunningItem[] = pid
    ? data.tasks
        .filter((t) => t.frontmatter.status === "running")
        .map((t) => ({
          pid,
          project: projectName(pid),
          taskId: t.frontmatter.id,
          title: t.frontmatter.title,
          ...(planTitle(t.frontmatter.planRef?.planId)
            ? { plan: planTitle(t.frontmatter.planRef?.planId) }
            : {}),
        }))
    : [];

  const first = (overview ? [...items.values()] : fallbackRunning)[0] ?? null;
  const single = (overview ? ids.length : fallbackRunning.length) === 1;
  const step = useRunningStep(
    single && first ? first.pid : null,
    single && first ? first.taskId : null,
  );
  const waiting = !!overview && waitingForReset(overview);
  const budgetSpent = (overview?.budgetExceeded.length ?? 0) > 0;
  // The budget's reset time is not in the overview: ask for it while a budget is spent.
  useEffect(() => {
    if (!budgetSpent) return setBudgetReset(null);
    let live = true;
    api.budget().then(
      (b) => live && setBudgetReset(b.resetsAt),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [budgetSpent, waiting]);
  const state = topbarState({
    noHarness: harnesses.status !== null && !harnesses.status.anyReady,
    resetAt: budgetSpent ? budgetReset : null,
    overview: denied ? null : overview,
    fallbackRunning,
    items,
    held,
    step,
    ...(pid ? { localPending: { [pid]: pendingCount(data.tasks) } } : {}),
  });

  const afterChange = () => Promise.all([reload(), data.refresh()]);
  const toggle = async () => {
    if (!state.toggle || state.toggle.disabled) return;
    const enable = state.toggle.label === "Start";
    await act(() => setRunner(enable, pid), {
      failure: enable ? "Could not start the runner" : "Could not pause the runner",
    });
    await afterChange();
  };
  const stop = async () => {
    setConfirming(false);
    try {
      const { failed, pauseFailed } = await stopAllRunning(
        state.running,
        () => setRunner(false, pid),
        (p, t) => api.stopTask(p, t),
      );
      if (failed.length > 0)
        toast.error(
          `Could not stop: ${failed.map((f) => `${itemLabel(f.item)} (${f.message})`).join("; ")}`,
        );
      else if (pauseFailed !== undefined)
        toast.warning(
          `Stop requested, but the runner was not paused (${pauseFailed}); it may start the next task.`,
        );
      else toast.success("Stop requested");
    } catch (err) {
      toast.error(`Could not stop: ${errorMessage(err)}`);
    }
    await afterChange();
  };

  const localPending = pid ? pendingCount(data.tasks) : 0;
  const queued = overview
    ? overview.projects.reduce(
        (n, p) => n + Math.max(p.counts.pending ?? 0, p.id === pid ? localPending : 0),
        0,
      )
    : 0;
  const next = nextStep({
    kind: state.kind,
    queued,
    tasks: data.tasks.map((t) => ({ status: t.frontmatter.status })),
    plans: data.plans,
  });
  const nextRoute = next && pid ? { name: next.to, pid } : null;

  // The last completion: kept for 10 minutes, until dismissed, or until new work starts.
  const [finished, setFinished] = useState<FinishedMemory>(EMPTY_FINISHED);
  // Done tasks across every project, from the server's counts (the task list holds one project).
  const doneTotal = overview ? overview.projects.reduce((n, p) => n + (p.counts.done ?? 0), 0) : 0;
  const runningKey = state.running.map((r) => `${r.pid}/${r.taskId}`).join("\n");
  useEffect(() => {
    // The first overview is not a finish, and a missing overview says nothing about the queue.
    if (!overview || denied) return;
    setFinished((m) =>
      stepFinished(m, {
        kind: state.kind,
        running: runningKey ? runningKey.split("\n") : [],
        queued,
        now: Date.now(),
        doneTotal,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- running is read through its key
  }, [overview, denied, state.kind, runningKey, queued, doneTotal]);
  const finishedAt = finished.finished?.at;
  useEffect(() => {
    if (finishedAt === undefined) return;
    const left = Math.max(0, finishedAt + FINISHED_TTL_MS - Date.now());
    const t = setTimeout(() => setFinished((m) => ({ ...m, finished: null })), left);
    return () => clearTimeout(t);
  }, [finishedAt]);

  // The profile chip: the project's own profile when set (changed in Project settings), else the
  // global active one, which the chip switches.
  const profiles = data.settings?.profiles ?? [];
  const activeId = data.settings?.activeProfile ?? null;
  const ownId = selected?.profile ?? null;
  const canSwitch = held === "all" || held.has("admin") || held.has("settings:write");
  const switchProfile = async (id: string) => {
    await act(() => api.updateSettings({ activeProfile: id || null }), {
      failure: "Could not change the profile",
    });
    await data.refresh();
  };

  // Keep the disclosure closed when there is nothing to list.
  const shown = open && state.running.length > 1;
  const prev = useRef(state.kind);
  useEffect(() => {
    if (prev.current !== state.kind && state.running.length < 2) setOpen(false);
    prev.current = state.kind;
  }, [state.kind, state.running.length]);

  const now = Date.now();
  const shownState = withFinished(state, finished, now);
  const tone = shownState.tone;
  const [stateWord, rest] = splitStateWord(shownState.text);
  const Icon = TONE_ICON[tone];
  const progress = planProgress(data, state);
  const working = tone === "planning" || tone === "working" || tone === "reviewing";

  return (
    <section
      role="region"
      aria-label="Runner"
      data-tone={tone}
      className="topbar sticky top-0 z-20 -mx-4 px-4 min-[720px]:-mx-8 min-[720px]:px-8"
    >
      <div className="mx-auto flex h-12 w-full max-w-[1320px] items-center gap-2 text-[length:var(--text-row)]">
        <span aria-live="polite" className="sr-only" data-testid="topbar-announce">
          {announcementOf(shownState, stateWord)}
        </span>
        <span title={shownState.text} className="flex min-w-0 flex-1 items-center gap-2">
          {tone === "idle" ? (
            <span aria-hidden className="topbar-dot size-2.5 shrink-0 rounded-full" />
          ) : (
            <Icon aria-hidden className="size-4 shrink-0" style={{ color: "var(--tb-dot)" }} />
          )}
          <span className="min-w-0 truncate">
            <span className="font-semibold">{stateWord}</span>
            {rest}
            {stale && <span> · status may be stale</span>}
          </span>
        </span>
        {working && progress && (
          <span className="hidden shrink-0 text-[length:var(--text-meta)] min-[720px]:inline">
            {progress.done} of {progress.total} tasks
          </span>
        )}
        {nextRoute && next && (
          <span className="hidden shrink-0 items-center gap-1 min-[900px]:flex">
            <span>{next.text}.</span>
            <a
              href={formatRoute(nextRoute as Parameters<typeof formatRoute>[0])}
              className="font-medium text-inherit underline"
            >
              {next.link}
            </a>
          </span>
        )}
        {state.running.length > 1 && (
          <IconBtn
            label={open ? "Hide details" : "Details"}
            title={open ? "Hide the running tasks" : "Show the running tasks"}
            expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </IconBtn>
        )}
        {profiles.length > 0 &&
          (ownId || !canSwitch ? (
            <span
              className="hidden shrink-0 rounded-full border border-current/30 px-2 py-0.5 text-[length:var(--text-meta)] min-[720px]:inline"
              title={ownId ? "Set for this project (Settings › Project)" : "Active profile"}
            >
              Profile:{" "}
              {profiles.find((p) => p.id === (ownId ?? activeId))?.name ?? ownId ?? "Custom roles"}
              {ownId ? " (project)" : ""}
            </span>
          ) : (
            <select
              aria-label="Active profile"
              title="Profile for tasks that start next"
              className="h-8 w-24 shrink-0 rounded-full border border-current/30 bg-transparent px-2 text-[length:var(--text-meta)] text-inherit min-[720px]:w-auto min-[720px]:max-w-40 [&>option]:bg-surface [&>option]:text-ink"
              value={activeId ?? ""}
              onChange={(e) => void switchProfile(e.target.value)}
            >
              <option value="">Custom roles</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ))}
        <ConnectionIndicator />
        {harnesses.status !== null && !harnesses.status.anyReady && (
          <a
            href={formatRoute({ name: "doctor" })}
            className="topbar-btn"
            aria-label="Fix: set up a coding agent"
            title="Fix: set up a coding agent"
          >
            <Wrench aria-hidden className="size-4" />
          </a>
        )}
        {needsYou > 0 && (
          <a
            href={formatRoute({ name: "inbox" })}
            className="topbar-btn relative"
            aria-label={`Needs you: ${needsYou}`}
            title={`Needs you: ${needsYou} to look at`}
          >
            <Bell aria-hidden className="size-4" />
            <span
              aria-hidden
              className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold"
              style={{ background: "var(--tb-fg)", color: "var(--tb-bg)" }}
            >
              {needsYou > 99 ? "99+" : needsYou}
            </span>
          </a>
        )}
        {state.toggle && (
          <IconBtn
            label={
              state.toggle.reason
                ? `${state.toggle.label}: ${state.toggle.reason}`
                : state.toggle.label
            }
            title={
              state.toggle.reason
                ? `${state.toggle.label}: ${state.toggle.reason}`
                : state.toggle.label === "Pause"
                  ? "Pause: start nothing new; running tasks finish"
                  : "Start the runner"
            }
            disabled={state.toggle.disabled}
            onClick={() => void toggle()}
          >
            {state.toggle.label === "Pause" ? (
              <Pause className="size-4" />
            ) : (
              <Play className="size-4" />
            )}
          </IconBtn>
        )}
        {state.stop && (
          <IconBtn
            label="Stop"
            title="Stop: stop the running tasks and pause the runner"
            onClick={() => setConfirming(true)}
          >
            <Square className="size-4" />
          </IconBtn>
        )}
        {tone === "finished" && (
          <IconBtn
            label="Dismiss"
            title="Dismiss: hide the finished message"
            onClick={() => setFinished((m) => ({ ...m, finished: null }))}
          >
            <X className="size-4" />
          </IconBtn>
        )}
      </div>
      {shown && (
        <ul className="mx-auto mt-1 mb-0 max-w-[1320px] list-none p-0 text-[length:var(--text-meta)]">
          {state.running.map((r) => (
            <li key={`${r.pid}/${r.taskId}`} className="truncate" title={itemLabel(r)}>
              {r.project} · {itemLabel(r)}
            </li>
          ))}
        </ul>
      )}
      <StopTaskDialog
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => void stop()}
        title={state.running.length === 1 ? "Stop task" : "Stop running tasks"}
        description={stopSummary(state.running)}
        confirmLabel="Stop and pause"
      />
      {working && progress && (
        <span
          aria-hidden
          className="topbar-progress"
          style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
        />
      )}
    </section>
  );
}
