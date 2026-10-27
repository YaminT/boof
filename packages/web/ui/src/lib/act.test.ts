import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api.js";
import { errorMessage, runAction } from "./act.js";

function notifier() {
  return { success: vi.fn(), error: vi.fn() };
}

describe("runAction", () => {
  it("returns the value and stays quiet without a success message", async () => {
    const n = notifier();
    expect(await runAction(async () => 7, n)).toBe(7);
    expect(n.success).not.toHaveBeenCalled();
    expect(n.error).not.toHaveBeenCalled();
  });

  it("announces success when a message is given", async () => {
    const n = notifier();
    expect(await runAction(async () => "ok", n, { success: "Queued" })).toBe("ok");
    expect(n.success).toHaveBeenCalledExactlyOnceWith("Queued");
  });

  it("reports an ApiError once, with the failure prefix, and resolves undefined", async () => {
    const n = notifier();
    const out = await runAction(() => Promise.reject(new ApiError("Task is running", 409)), n, {
      failure: "Could not queue",
    });
    expect(out).toBeUndefined();
    expect(n.error).toHaveBeenCalledExactlyOnceWith("Could not queue: Task is running");
    expect(n.success).not.toHaveBeenCalled();
  });

  it("explains a rejected API key on 401", async () => {
    const n = notifier();
    await runAction(() => Promise.reject(new ApiError("Unauthorized", 401)), n);
    expect(n.error).toHaveBeenCalledExactlyOnceWith("Your API key was rejected. Enter a new one.");
  });

  it("reports a thrown string as is", async () => {
    const n = notifier();
    await runAction(() => Promise.reject("boom"), n);
    expect(n.error).toHaveBeenCalledExactlyOnceWith("boom");
  });
});

describe("errorMessage", () => {
  it("uses the message of a plain Error", () => {
    expect(errorMessage(new Error("nope"))).toBe("nope");
  });
});
