import { ApiError } from "../api.js";

/** Which kind of stale write a 409 reports: a plan version or a task's `updated`; else null. */
export function conflictOf(err: unknown): "plan" | "task" | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  if (err.code === "plan_version_conflict") return "plan";
  if (err.code === "task_modified") return "task";
  return null;
}
