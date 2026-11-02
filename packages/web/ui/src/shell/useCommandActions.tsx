import { useState, type ReactNode } from "react";
import type { Project } from "@boof-runner/shared/schema";
import { api, type TaskView } from "../api.js";
import type { AppData } from "../useAppData.js";
import type { Route } from "../lib/route.js";
import { act } from "../lib/act.js";
import { createCommandActions, type CommandAction } from "../lib/command-actions.js";
import { useTheme } from "../lib/theme.js";
import { toggleRunner } from "./RunnerSwitch.js";
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
  mode,
}: {
  data: AppData;
  projects: Project[] | null;
  pid: string | null;
  navigate: (to: Route) => void;
  onSelectProject: (id: string) => void;
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
    await data.refresh();
  };

  const actions = createCommandActions({
    pid,
    projects: projects ?? [],
    tasks: data.tasks,
    plans: data.plans,
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
