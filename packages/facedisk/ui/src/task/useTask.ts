import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type TaskView } from "../api.js";

/**
 * One task with its log. It refetches when `listKey` changes: a key built from the `updated`,
 * `steps` length and `status` of the task's row in the live list (null when the row is absent).
 * The list refreshes on every task-file write, so no timer is needed.
 * A 404 sets `missing`; any other failure sets `failed` until the next load succeeds.
 * A response older than one already applied is dropped.
 */
export function useTask(pid: string, id: string, listKey: string | null) {
  const [task, setTask] = useState<TaskView | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
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
      setFailed(false);
    } catch (e) {
      if (seq < applied.current) return;
      applied.current = seq;
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setFailed(true);
    }
  }, [pid, id]);

  useEffect(() => {
    void reload();
  }, [reload, listKey]);

  return { task, missing, failed, reload };
}
