/** When this browser first saw each task running, keyed by project and id; the server has no start time yet. */
const firstSeen = new Map<string, number>();

const key = (pid: string, id: string) => `${pid}/${id}`;

/**
 * Record ids that just started running in project `pid` and forget that project's ids that no
 * longer run, so a task that runs again starts a fresh clock. Other projects' entries are left
 * alone, so switching project does not reset a task that is still running. Pass the full list
 * of running ids of `pid` each time it changes.
 */
export function markRunning(pid: string, ids: string[], now: number): void {
  const running = new Set(ids.map((id) => key(pid, id)));
  const prefix = `${pid}/`;
  for (const k of [...firstSeen.keys()])
    if (k.startsWith(prefix) && !running.has(k)) firstSeen.delete(k);
  for (const k of running) if (!firstSeen.has(k)) firstSeen.set(k, now);
}

/** The time the task was first seen running, or undefined if it is not known to run. */
export function startedAt(pid: string, id: string): number | undefined {
  return firstSeen.get(key(pid, id));
}
