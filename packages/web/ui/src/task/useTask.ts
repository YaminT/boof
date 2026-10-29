import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type TaskView } from "../api.js";

const POLL_MS = 5000;

/**
 * One task with its log. It refetches when `listUpdated` (the `updated` stamp of the task's row in
 * the live list, null when the row is absent) changes, and every 5 s while the task runs: the
 * server records steps without bumping `updated`, so the step strip would freeze otherwise.
 * A 404 sets `missing` and stops the polling. A response older than one already applied is dropped.
 */
export function useTask(pid: string, id: string, listUpdated: string | null) {
  const [task, setTask] = useState<TaskView | null>(null);
  const [missing, setMissing] = useState(false);
  const sent = useRef(0);
  const applied = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++sent.current;
    try {
      const t = await api.getTask(pid, id);
      if (seq < applied.current) return;
      applied.current = seq;
      setTask(t);
      setMissing(false);
    } catch (e) {
      if (seq < applied.current) return;
      if (e instanceof ApiError && e.status === 404) {
        applied.current = seq;
        setMissing(true);
      }
    }
  }, [pid, id]);

  useEffect(() => {
    void reload();
  }, [reload, listUpdated]);

  const running = task?.frontmatter.status === "running" && !missing;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, reload]);

  return { task, missing, reload };
}
