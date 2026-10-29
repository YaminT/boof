import { useEffect, useState } from "react";
import type { TaskView } from "../api.js";
import { startedAt } from "../lib/first-seen.js";
import { startedAtMs } from "../lib/run-timing.js";

/**
 * Seconds since the task started running, ticking each second; null if not running. The start
 * is the task's recorded `startedAt`; tasks started before that was recorded fall back to when
 * this browser first saw them run (`lib/first-seen`, kept in step by App).
 */
export function useElapsed(pid: string, task: TaskView, running: boolean): number | null {
  const id = task.frontmatter.id;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, id]);

  if (!running) return null;
  const start = startedAtMs(task) ?? startedAt(pid, id) ?? now;
  return Math.max(0, Math.floor((now - start) / 1000));
}
