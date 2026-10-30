import { describe, expect, it, vi } from "vitest";
import type { RunnerEngine } from "@boof-runner/runner";
import { createQuitHandler, serverOptions, shutdownGraceMs } from "./lifecycle.js";

describe("desktop /healthz facts", () => {
  it("passes the app version and a live runnerRunning to the server", () => {
    let engine: RunnerEngine | null = null;
    const opts = serverOptions({ root: "/r", port: 4319, uiDir: "/ui" }, "0.2.0", () => engine);
    expect(opts).toMatchObject({ root: "/r", port: 4319, uiDir: "/ui", version: "0.2.0" });
    expect(opts.runnerRunning?.()).toBe(false);
    engine = {} as RunnerEngine; // engine.loop() started
    expect(opts.runnerRunning?.()).toBe(true);
  });

  it("reads the grace period from BOOF_RUNNER_SHUTDOWN_GRACE_MS, default 30 s", () => {
    expect(shutdownGraceMs({})).toBe(30_000);
    expect(shutdownGraceMs({ BOOF_RUNNER_SHUTDOWN_GRACE_MS: "5000" })).toBe(5_000);
    expect(shutdownGraceMs({ BOOF_RUNNER_SHUTDOWN_GRACE_MS: "soon" })).toBe(30_000);
  });
});

describe("desktop before-quit", () => {
  const setup = () => {
    const order: string[] = [];
    let release!: () => void;
    const drained = new Promise<void>((r) => (release = r));
    const engine = {
      shutdown: vi.fn(async (graceMs: number) => {
        order.push(`shutdown ${graceMs}`);
        await drained;
        return { stopped: ["t1"], timedOut: false };
      }),
    };
    const server = { stop: vi.fn(async () => void order.push("server.stop")) };
    const exit = vi.fn((code: number) => void order.push(`exit ${code}`));
    const log: string[] = [];
    const quit = createQuitHandler({
      engine: () => engine,
      server: () => server,
      exit,
      graceMs: 5_000,
      log: (l) => log.push(l),
    });
    return { order, release, engine, server, exit, log, quit };
  };

  it("defers the quit, drains the engine, stops the server, then exits 0", async () => {
    const s = setup();
    const event = { preventDefault: vi.fn() };
    const pending = s.quit(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(s.order).toEqual(["shutdown 5000"]); // nothing else until the engine drained
    s.release();
    await pending;
    expect(s.order).toEqual(["shutdown 5000", "server.stop", "exit 0"]);
    expect(s.log).toContain("Stopped running task(s): t1");
  });

  it("a second quit request while draining is not deferred", async () => {
    const s = setup();
    const first = s.quit({ preventDefault: vi.fn() });
    const again = { preventDefault: vi.fn() };
    expect(s.quit(again)).toBeUndefined();
    expect(again.preventDefault).not.toHaveBeenCalled();
    expect(s.engine.shutdown).toHaveBeenCalledTimes(1);
    s.release();
    await first;
  });

  it("exits 0 even when the engine shutdown rejects, and logs it", async () => {
    const s = setup();
    s.engine.shutdown.mockRejectedValueOnce(new Error("disk gone"));
    await s.quit({ preventDefault: vi.fn() });
    expect(s.order).toEqual(["exit 0"]);
    expect(s.log.some((l) => l.includes("disk gone"))).toBe(true);
  });

  it("says when the grace period ran out", async () => {
    const s = setup();
    s.engine.shutdown.mockImplementationOnce(async (graceMs: number) => {
      s.order.push(`shutdown ${graceMs}`);
      return { stopped: ["t1"], timedOut: true };
    });
    await s.quit({ preventDefault: vi.fn() });
    expect(s.log).toContain("Grace period of 5000 ms elapsed; quitting anyway");
    expect(s.order).toEqual(["shutdown 5000", "server.stop", "exit 0"]);
  });
});
