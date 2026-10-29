import { api, type TaskView } from "../api.js";
import { act } from "../lib/act.js";
import type { Route, TaskView as RouteView } from "../lib/route.js";
import type { AppData } from "../useAppData.js";

/** The things a row can do; each reports through a toast and refreshes the list. */
export function useTaskActions(pid: string, data: AppData, navigate: (to: Route) => void) {
  const run = (fn: () => Promise<unknown>, success: string | undefined, failure: string) =>
    void act(fn, { success, failure }).then(() => data.refresh());
  const go = (taskId: string, view: RouteView = "edit") =>
    navigate({ name: "task", pid, taskId, view });

  return {
    open: (id: string) => go(id),
    answer: (id: string) => go(id, "questions"),
    openChanges: (id: string) => go(id, "changes"),
    openPlan: (planId: string) => navigate({ name: "plans", pid, planId }),
    queue: (id: string) =>
      run(() => api.updateTask(pid, id, { status: "pending" }), "Queued", "Could not queue"),
    retry: (id: string) => run(() => api.retry(pid, id), "Queued again", "Could not retry"),
    archive: (id: string) => run(() => api.archive(pid, id), "Archived", "Could not archive"),
    unarchive: (id: string) =>
      run(() => api.unarchive(pid, id), "Unarchived", "Could not unarchive"),
    setSkip: (id: string, skip: boolean) =>
      run(
        () => api.setSkip(pid, id, skip),
        skip ? "Skipped" : "Unskipped",
        skip ? "Could not skip" : "Could not unskip",
      ),
    stop: (id: string) => run(() => api.stopTask(pid, id), "Stop requested", "Could not stop"),
    duplicate: (task: TaskView) =>
      run(
        async () => {
          const full = await api.getTask(pid, task.frontmatter.id);
          const f = task.frontmatter;
          return api.createTask(pid, {
            title: `${f.title} (copy)`,
            prompt: full.body.prompt,
            priority: f.priority,
            labels: f.labels,
            command: f.command,
            runs: f.runs,
            status: "draft",
          });
        },
        "Duplicated",
        "Could not duplicate",
      ),
    copyId: (id: string) =>
      void act(() => navigator.clipboard.writeText(id), {
        success: "Copied",
        failure: "Could not copy",
      }),
  };
}

export type TaskActions = ReturnType<typeof useTaskActions>;
