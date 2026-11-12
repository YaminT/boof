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
): Promise<{ plan: Plan; created: number }> {
  const active = await api.updatePlan(pid, plan, { status: "active" });
  try {
    const report = await api.syncPlan(pid, active.id, false);
    return { plan: active, created: report.created.length };
  } catch (err) {
    throw new Error(`the plan is active, but its tasks were not created (${errorMessage(err)})`, {
      cause: err,
    });
  }
}

/** Say how the "Create tasks" step ended: "Tasks created" only when tasks were created. */
export function reportCreated(created: number): void {
  if (created > 0) toast.success(`Tasks created (${created})`);
  else toast.warning("The plan is active, but no new tasks were created.");
}
