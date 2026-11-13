import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@boof/heart/schema";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { api, type TaskView } from "../api.js";
import type { AppData } from "../useAppData.js";
import { act, errorMessage } from "../lib/act.js";
import { formatRoute } from "../lib/route.js";
import { useHeldScopes } from "../lib/useHeldScopes.js";
import { useRunnerOverview } from "../lib/useRunnerOverview.js";
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
} from "../lib/topbar.js";
import { StopTaskDialog } from "./StopTaskDialog.js";
import { toast } from "sonner";

/** Titles of tasks in projects other than the selected one, fetched once per id. */
const otherTitles = new Map<string, TaskView | null>();

const KIND_STYLE = {
  running: "border-transparent bg-done text-white dark:text-page",
  draining: "border-attention/40 bg-attention/15 text-ink",
  idle: "border-line bg-surface text-ink",
  waiting: "border-attention/40 bg-attention/15 text-ink",
  paused: "border-line bg-surface text-ink-muted",
  blocked: "border-attention/40 bg-attention/15 text-ink",
  unknown: "border-line bg-surface text-ink-muted",
} as const;

/** One bar above every screen: what the runner does, and Pause, Start and Stop. */
export function TopBar({
  data,
  projects,
  selected,
  needsYou,
  harnesses,
}: {
  data: AppData;
  projects: Project[] | null;
  selected: Project | null;
  needsYou: number;
  harnesses: HarnessesState;
}) {
  const held = useHeldScopes();
  const { overview, denied, stale, reload } = useRunnerOverview();
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

  return (
    <section
      role="region"
      aria-label="Runner"
      className={cn(
        "sticky top-0 z-20 -mx-4 border-b px-4 py-1.5 min-[720px]:-mx-8 min-[720px]:px-8",
        KIND_STYLE[state.kind],
      )}
    >
      <div className="mx-auto flex w-full max-w-[1320px] items-center gap-2 text-[length:var(--text-row)]">
        <span aria-live="polite" title={state.text} className="min-w-0 flex-1 truncate font-medium">
          {state.text}
          {stale && <span className="font-normal"> · status may be stale</span>}
        </span>
        {state.running.length > 1 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 min-w-8 text-ink"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Hide" : "Details"}
          </Button>
        )}
        {nextRoute && next && (
          <span className="hidden shrink-0 items-center gap-1 min-[720px]:flex">
            <span>{next.text}.</span>
            <a
              href={formatRoute(nextRoute as Parameters<typeof formatRoute>[0])}
              className="font-medium text-inherit underline"
            >
              {next.link}
            </a>
          </span>
        )}
        {profiles.length > 0 &&
          (ownId || !canSwitch ? (
            <span
              className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[length:var(--text-meta)]"
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
              className="h-8 max-w-40 shrink-0 rounded-full border border-line bg-surface px-2 text-[length:var(--text-meta)] text-ink"
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
        {harnesses.status !== null && !harnesses.status.anyReady && (
          <a
            href={formatRoute({ name: "doctor" })}
            className="shrink-0 font-medium text-inherit underline"
          >
            Fix
          </a>
        )}
        {needsYou > 0 && (
          <a
            href={formatRoute({ name: "inbox" })}
            className="shrink-0 font-medium text-inherit underline"
          >
            Needs you: {needsYou}
          </a>
        )}
        {state.toggle && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 min-w-8 text-ink"
            disabled={state.toggle.disabled}
            title={
              state.toggle.reason ??
              (state.toggle.label === "Pause"
                ? "Start nothing new; running tasks finish"
                : "Start the runner")
            }
            aria-label={
              state.toggle.reason ? `Start (disabled: ${state.toggle.reason})` : state.toggle.label
            }
            onClick={() => void toggle()}
          >
            {state.toggle.label}
          </Button>
        )}
        {state.stop && (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="h-8 min-w-8"
            onClick={() => setConfirming(true)}
          >
            Stop
          </Button>
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
    </section>
  );
}
