import { ApiError } from "../api.js";

/** Which kind of stale write a 409 reports: a plan version or a task's `updated`; else null. */
export function conflictOf(err: unknown): "plan" | "task" | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  if (err.code === "plan_version_conflict") return "plan";
  if (err.code === "task_modified") return "task";
  return null;
}

/**
 * The status an Overwrite repeats: the one the refused save carried (Queue), but only while that
 * refusal is still the open conflict. After Reload, or a notice that came from a live change and
 * not from a 409, Overwrite only keeps the user's text and never queues anything.
 */
export function overwriteStatus<S extends string>(
  inConflict: boolean,
  remembered: S | undefined,
): S | undefined {
  return inConflict ? remembered : undefined;
}
