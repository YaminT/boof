/**
 * The line under "Nothing running." when the runner is on, the project is not paused, and the
 * queue is not empty. The other empty states have their own copy.
 */
export function idleQueueNote(
  queued: number,
  runnerPaused: boolean,
  projectPaused: boolean,
): string | null {
  if (queued <= 0 || runnerPaused || projectPaused) return null;
  const n = queued === 1 ? "1 task is queued." : `${queued} tasks are queued.`;
  return `${n} The runner starts the next one when a slot is free.`;
}
