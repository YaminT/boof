import { z } from "zod";

/** A non-fatal notice in an operation result: the server changed a value you asked for, or something worth knowing about the change. */
export const WarningSchema = z.object({
  code: z.enum(["status_downgraded", "subtasks_open"]),
  message: z.string(),
  /** The input field that was changed. */
  field: z.string(),
  requested: z.string(),
  applied: z.string(),
});
export type Warning = z.infer<typeof WarningSchema>;

/** The warnings of a result (`warnings` array), or none. */
export function warningsOf(result: unknown): Warning[] {
  if (typeof result !== "object" || result === null) return [];
  const w = (result as { warnings?: unknown }).warnings;
  return Array.isArray(w) ? (w as Warning[]) : [];
}

/** A review-trust client asked for a status that only a human may grant. */
export function statusDowngraded(
  what: "plan" | "task",
  requested: string,
  applied: string,
): Warning {
  return {
    code: "status_downgraded",
    message:
      what === "plan"
        ? `Requested plan status ${requested} was changed to ${applied}: this client has review trust. Ask the user to approve the plan in the Plans tab.`
        : `Requested task status ${requested} was changed to ${applied}: this client has review trust. Ask the user to queue the task in the Tasks tab (Proposed by clients).`,
    field: "status",
    requested,
    applied,
  };
}

/** A parent was queued while some of its subtasks are not done. Informational: nothing waits for them. */
export function subtasksOpen(taskId: string, open: number, total: number): Warning {
  return {
    code: "subtasks_open",
    message: `Task ${taskId} was queued while ${open} of its ${total} subtasks are not done; nothing waits for them.`,
    field: "status",
    requested: "pending",
    applied: "pending",
  };
}
