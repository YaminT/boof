import { toast } from "sonner";
import { api, type Plan } from "../api.js";
import { errorMessage } from "./act.js";

/**
 * Activate a plan and create its tasks. Activation alone creates nothing (the plan syncs only
 * when someone presses "Update tasks"), so every "Create tasks" entry point runs the sync right
 * after it and reports how many tasks it created. When the sync fails the plan stays active and
 * the error says so.
 */
export async function activateWithTasks(
  pid: string,
  plan: { id: string; version: number },
): Promise<{ plan: Plan; created: number; ready: number; waiting: number }> {
  const active = await api.updatePlan(pid, plan, { status: "active", autoSync: true });
  try {
    const report = await api.syncPlan(pid, active.id, false, true);
    const created = report.created.length;
    const waiting = report.created.filter((c) => c.skip).length;
    return { plan: active, created, ready: created - waiting, waiting };
  } catch (err) {
    throw new Error(`the plan is active, but its tasks were not created (${errorMessage(err)})`, {
      cause: err,
    });
  }
}

/** Say how the "Create tasks" step ended: "Tasks created" only when tasks were created. */
export function createdMessage(created: number, waiting: number): string {
  const word = created === 1 ? "task" : "tasks";
  return `${created} ${word} created (${created - waiting} ready, ${waiting} waiting for earlier tasks)`;
}

export function reportCreated(created: number, waiting = 0): void {
  if (created > 0) toast.success(createdMessage(created, waiting));
  else toast.warning("The plan is active, but no new tasks were created.");
}
