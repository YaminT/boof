import { describe, expect, it, vi } from "vitest";
import { sleepUnlessAborted } from "./abort.js";

const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

describe("sleepUnlessAborted", () => {
  it("returns at once on abort and leaves no timer behind", async () => {
    const before = timers();
    const ctrl = new AbortController();
    const sleeping = sleepUnlessAborted(60_000, ctrl.signal);
    expect(timers()).toBe(before + 1);
    ctrl.abort();
    expect(await sleeping).toBe("aborted");
    expect(timers()).toBe(before);
  });

  it("an already aborted signal never starts a timer", async () => {
    const before = timers();
    expect(await sleepUnlessAborted(60_000, AbortSignal.abort())).toBe("aborted");
    expect(timers()).toBe(before);
  });

  it("elapses normally with no signal or a quiet one, and drops its listener", async () => {
    expect(await sleepUnlessAborted(1)).toBe("elapsed");
    const ctrl = new AbortController();
    const add = vi.spyOn(ctrl.signal, "addEventListener");
    const remove = vi.spyOn(ctrl.signal, "removeEventListener");
    expect(await sleepUnlessAborted(1, ctrl.signal)).toBe("elapsed");
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][1]).toBe(add.mock.calls[0][1]);
    ctrl.abort(); // nothing is listening any more: no throw, nothing pending
  });
});
