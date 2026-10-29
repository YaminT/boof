/** When this browser first saw each task running; the server has no start time yet. */
const firstSeen = new Map<string, number>();

/**
 * Record ids that just started running and forget ids that no longer run, so a task that runs
 * again starts a fresh clock. Pass the full list of running ids each time it changes.
 */
export function markRunning(ids: string[], now: number): void {
  const running = new Set(ids);
  for (const id of [...firstSeen.keys()]) if (!running.has(id)) firstSeen.delete(id);
  for (const id of running) if (!firstSeen.has(id)) firstSeen.set(id, now);
}

/** The time the task was first seen running, or undefined if it is not known to run. */
export function startedAt(id: string): number | undefined {
  return firstSeen.get(id);
}
