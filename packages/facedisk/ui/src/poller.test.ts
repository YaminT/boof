import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPoller } from "./lib/poller.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startPoller", () => {
  it("polls every 30 s while the stream is up and every 10 s while it is down", async () => {
    let up = true;
    const load = vi.fn(async () => {});
    const p = startPoller({ load, live: () => up });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(3); // 0, 30, 60
    up = false;
    p.replan();
    load.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(6);
    p.stop();
  });

  it("backs off exponentially on errors, capped at 60 s", async () => {
    const load = vi.fn(async () => {
      throw new Error("down");
    });
    const p = startPoller({ load, live: () => true });
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    // Retries at +5, +10, +20, +40, +60, +60 s.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(load).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(load).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(load).toHaveBeenCalledTimes(6);
    expect(p.failures()).toBe(6);
    p.stop();
  });

  it("coalesces kicks", async () => {
    const load = vi.fn(async () => {});
    const p = startPoller({ load, live: () => true });
    await vi.advanceTimersByTimeAsync(0);
    p.kick();
    p.kick();
    p.kick();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(load).toHaveBeenCalledTimes(2);
    p.stop();
  });
});
