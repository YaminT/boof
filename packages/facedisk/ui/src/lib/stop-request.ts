import { useSyncExternalStore } from "react";
import type { TaskView } from "../api.js";

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
const listeners = new Map<string, Set<() => void>>();
const allListeners = new Set<() => void>();
const key = (pid: string, id: string) => `${pid}/${id}`;

function emit(k: string): void {
  for (const listener of listeners.get(k) ?? []) listener();
  for (const listener of allListeners) listener();
}

export function isStopPending(pid: string, id: string): boolean {
  return pending.has(key(pid, id));
}

export function markStopPending(pid: string, id: string): void {
  const k = key(pid, id);
  if (pending.has(k)) return;
  pending.add(k);
  emit(k);
}

export function clearStopPending(pid: string, id: string): void {
  const k = key(pid, id);
  if (!pending.delete(k)) return;
  emit(k);
}
export function subscribeStopPending(pid: string, id: string, listener: () => void): () => void {
  const k = key(pid, id);
  const subscribers = listeners.get(k) ?? new Set<() => void>();
  subscribers.add(listener);
  listeners.set(k, subscribers);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) listeners.delete(k);
  };
}

/** Subscribe to the shared per-tab stop latch for one task. */
export function useStopRequested(pid: string, id: string): boolean {
  const k = key(pid, id);
  return useSyncExternalStore(
    (listener) => subscribeStopPending(pid, id, listener),
    () => pending.has(k),
    () => false,
  );
}

/** Subscribe to pending stop changes for a task list (used to disable palette actions). */
export function usePendingStopKeys(tasks: TaskView[]): ReadonlySet<string> {
  const taskKeys = tasks.map((task) => key(task.projectId, task.frontmatter.id));
  const subscribeAll = (listener: () => void) => {
    allListeners.add(listener);
    return () => allListeners.delete(listener);
  };
  const getSnapshot = () => taskKeys.filter((k) => pending.has(k)).join("\n");
  const snapshot = useSyncExternalStore(subscribeAll, getSnapshot, () => "");
  return new Set(snapshot ? snapshot.split("\n") : []);
}
