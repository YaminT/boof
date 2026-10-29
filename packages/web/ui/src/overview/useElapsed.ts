import { useEffect, useState } from "react";

/** When this browser first saw each task running; the server has no start time yet. */
const firstSeen = new Map<string, number>();

/** Seconds since this browser first saw the task running, ticking each second; null if not running. */
export function useElapsed(taskId: string, running: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (!running) {
    firstSeen.delete(taskId);
    return null;
  }
  let start = firstSeen.get(taskId);
  if (start === undefined) {
    start = Date.now();
    firstSeen.set(taskId, start);
  }
  return Math.max(0, Math.floor((now - start) / 1000));
}
