import { useState, type ReactNode } from "react";
import type { Project } from "@boof-runner/shared/schema";
import { api, type TaskView } from "../api.js";
import type { AppData } from "../useAppData.js";
import type { Route } from "../lib/route.js";
import { act } from "../lib/act.js";
import { createCommandActions, type CommandAction } from "../lib/command-actions.js";
import { useTheme } from "../lib/theme.js";
import { toggleRunner } from "./RunnerSwitch.js";
import type { Epics } from "../tasks/useEpics.js";
import { withQuery } from "../lib/task-links.js";
import { StopTaskDialog } from "./StopTaskDialog.js";

interface PendingStop {
  task: TaskView;
  resolve(): void;
  reject(err: unknown): void;
}

/**
 * The shared actions with their effects wired to the app. `toast` reports outcomes as toasts and
 * never throws (the palette); `throw` lets a failure reach the caller (the console prints it).
 * Stopping a task asks first through `stopDialog`, which the caller must render.
 */
export function useCommandActions({
  data,
  projects,
  pid,
  navigate,
  onSelectProject,
  epics,
  currentTask,
  mode,
}: {
  data: AppData;
  projects: Project[] | null;
  pid: string | null;
  navigate: (to: Route) => void;
  onSelectProject: (id: string) => void;
  epics: Epics;
  /** The task open on screen, which the hierarchy actions apply to. */
  currentTask: TaskView | null;
  mode: "toast" | "throw";
}): { actions: CommandAction[]; stopDialog: ReactNode } {
  const { setPref } = useTheme();
  const [stopping, setStopping] = useState<PendingStop | null>(null);

  const mutate = async (
    fn: () => Promise<unknown>,
    success: string,
    failure: string,
  ): Promise<void> => {
    if (mode === "throw") await fn();
    else await act(fn, { success, failure });
    await Promise.all([data.refresh(), epics.reload()]);
  };

  const actions = createCommandActions({
    pid,
    projects: projects ?? [],
    tasks: data.tasks,
    plans: data.plans,
    epics: epics.list,
    currentTask,
    runnerEnabled: data.settings?.runner.enabled ?? false,
    settingsLoaded: !!data.settings,
    effects: {
      navigate,
      selectProject: onSelectProject,
      setTheme: setPref,
      requestStop: (task) =>
        new Promise<void>((resolve, reject) => setStopping({ task, resolve, reject })),
      activatePlan: (id, plan) =>
        mutate(
          () => api.updatePlan(id, plan, { status: "active" }),
          "Plan activated",
          "Could not activate",
        ),
      queueTask: (id, taskId) =>
        mutate(
          () => api.updateTask(id, taskId, { status: "pending" }),
          "Queued",
          "Could not queue",
        ),
      createEpic: (id, title) =>
        mutate(() => api.createEpic(id, { title }), "Epic added", "Could not add the epic"),
      openNewEpic: (id) => {
        // The Tasks screen opens the sheet when it sees ?manage=epics, then drops the query.
        navigate({ name: "tasks", pid: id });
        history.replaceState(
          null,
          "",
          withQuery(window.location.pathname, window.location.search, "manage", "epics"),
        );
        window.dispatchEvent(new PopStateEvent("popstate"));
      },
      moveTask: (id, taskId, move) =>
        mutate(() => api.moveTask(id, taskId, move), "Moved", "Could not move the task"),
      setRunner: (enabled) =>
        mode === "throw"
          ? api.updateSettings({ runner: { enabled: !enabled } }).then(() => data.refresh())
          : toggleRunner(enabled).then(() => data.refresh()),
    },
  });

  const stopDialog = (
    <StopTaskDialog
      open={stopping !== null}
      onOpenChange={(o) => {
        if (o || !stopping) return;
        stopping.reject(new Error("cancelled"));
        setStopping(null);
      }}
      onConfirm={() => {
        const s = stopping;
        setStopping(null);
        if (!s || !pid) return s?.reject(new Error("no project selected"));
        const id = s.task.frontmatter.id;
        mutate(() => api.stopTask(pid, id), "Stop requested", "Could not stop").then(
          s.resolve,
          s.reject,
        );
      }}
    />
  );
  return { actions, stopDialog };
}
