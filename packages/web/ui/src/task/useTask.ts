import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type TaskView } from "../api.js";

const POLL_MS = 5000;

/**
 * One task with its log. It refetches when `listUpdated` (the `updated` stamp of the task's row in
 * the live list, null when the row is absent) changes, and every 5 s while the task runs: the
 * server records steps without bumping `updated`, so the step strip would freeze otherwise.
 * A 404 sets `missing`.
 */
export function useTask(pid: string, id: string, listUpdated: string | null) {
  const [task, setTask] = useState<TaskView | null>(null);
  const [missing, setMissing] = useState(false);

  const reload = useCallback(async () => {
    try {
      setTask(await api.getTask(pid, id));
      setMissing(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
    }
  }, [pid, id]);

  useEffect(() => {
    void reload();
  }, [reload, listUpdated]);

  const running = task?.frontmatter.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, reload]);

  return { task, missing, reload };
}
