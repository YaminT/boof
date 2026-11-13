import { beforeEach, describe, expect, it, vi } from "vitest";

const { updatePlan, syncPlan, toast } = vi.hoisted(() => ({
  updatePlan: vi.fn(),
  syncPlan: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn() },
}));
vi.mock("../api.js", async (orig) => ({
  ...(await orig<typeof import("../api.js")>()),
  api: {
    updatePlan: (...a: unknown[]) => updatePlan(...a),
    syncPlan: (...a: unknown[]) => syncPlan(...a),
  },
}));
vi.mock("sonner", () => ({ toast }));

import { activateWithTasks, reportCreated } from "./activate.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("activateWithTasks", () => {
  it("activates the plan, then syncs it for real so the tasks exist", async () => {
    updatePlan.mockResolvedValue({ id: "p1", version: 3, status: "active" });
    syncPlan.mockResolvedValue({
      created: [
        { taskId: "a", skip: false },
        { taskId: "b", skip: true },
      ],
      updated: [],
      skipped: [],
    });
    const r = await activateWithTasks("proj", { id: "p1", version: 2 });
    expect(updatePlan).toHaveBeenCalledWith(
      "proj",
      { id: "p1", version: 2 },
      {
        status: "active",
        autoSync: true,
      },
    );
    expect(syncPlan).toHaveBeenCalledWith("proj", "p1", false, true);
    expect(r).toMatchObject({ created: 2, ready: 1, waiting: 1 });
  });

  it("says the plan is active but no tasks exist when the sync fails", async () => {
    updatePlan.mockResolvedValue({ id: "p1", version: 3, status: "active" });
    syncPlan.mockRejectedValue(new Error("boom"));
    await expect(activateWithTasks("proj", { id: "p1", version: 2 })).rejects.toThrow(
      /plan is active, but its tasks were not created \(boom\)/,
    );
  });

  it("does not sync when activation fails", async () => {
    updatePlan.mockRejectedValue(new Error("stale"));
    await expect(activateWithTasks("proj", { id: "p1", version: 2 })).rejects.toThrow("stale");
    expect(syncPlan).not.toHaveBeenCalled();
  });
});

describe("reportCreated", () => {
  it("says 'Tasks created' only when tasks were created", () => {
    reportCreated(0);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalled();
    reportCreated(9, 8);
    expect(toast.success).toHaveBeenCalledWith(
      "9 tasks created (1 ready, 8 waiting for earlier tasks)",
    );
  });
});
