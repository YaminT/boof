/**
 * Stop stays disabled from the moment a stop is requested until the task leaves "running".
 * The server records the request in the task's control directory, which the task view does not
 * carry, so the UI keeps a latch and clears it when the status changes or the request fails.
 * Pass `requested: false` for a failed request: Stop is enabled again while the task still runs.
 */
export function stopDisabled(status: string, requested: boolean): boolean {
  return requested && status === "running";
}
const pending = new Set<string>();
const key = (pid: string, id: string) => `${pid}/${id}`;

export function isStopPending(pid: string, id: string): boolean {
  return pending.has(key(pid, id));
}

export function markStopPending(pid: string, id: string): void {
  pending.add(key(pid, id));
}

export function clearStopPending(pid: string, id: string): void {
  pending.delete(key(pid, id));
}
