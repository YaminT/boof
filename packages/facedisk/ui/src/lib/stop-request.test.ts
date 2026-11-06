import { describe, expect, it, vi } from "vitest";
import {
  clearStopPending,
  isStopPending,
  markStopPending,
  stopDisabled,
  subscribeStopPending,
} from "./stop-request.js";

describe("stopDisabled", () => {
  it("keeps a stop request visible across screens until cleared", () => {
    expect(isStopPending("project", "task")).toBe(false);
    markStopPending("project", "task");
    expect(isStopPending("project", "task")).toBe(true);
    expect(isStopPending("other-project", "task")).toBe(false);
    clearStopPending("project", "task");
    expect(isStopPending("project", "task")).toBe(false);
  });

  it("stays disabled from the request until the task leaves running", () => {
    expect(stopDisabled("running", true)).toBe(true);
    expect(stopDisabled("stopped", true)).toBe(false);
    expect(stopDisabled("failed", true)).toBe(false);
    expect(stopDisabled("done", true)).toBe(false);
  });

  it("enables Stop again when the request fails, while the task is still running", () => {
    expect(stopDisabled("running", false)).toBe(false);
  });
  it("publishes latch changes to subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeStopPending("subscribed", "task", listener);
    markStopPending("subscribed", "task");
    expect(listener).toHaveBeenCalledOnce();
    clearStopPending("subscribed", "task");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
