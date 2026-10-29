import { useEffect, useState } from "react";
import { startedAt } from "../lib/first-seen.js";

/**
 * Seconds since this browser first saw the task running, ticking each second; null if not
 * running. The start time comes from `lib/first-seen`, which App keeps in step with the running
 * tasks, so a task that runs again starts from zero.
 */
export function useElapsed(taskId: string, running: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, taskId]);

  if (!running) return null;
  return Math.max(0, Math.floor((now - (startedAt(taskId) ?? now)) / 1000));
}
