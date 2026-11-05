import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const packageVersion = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL("../../", import.meta.url)), "package.json"), "utf8"),
).version as string;

const { startServer, constructEngine, engineLoop, engineShutdown } = vi.hoisted(() => ({
  startServer: vi.fn(),
  constructEngine: vi.fn(),
  engineLoop: vi.fn(),
  engineShutdown: vi.fn(),
}));
vi.mock("@boof/heart-server", () => ({ startServer }));
vi.mock("@boof/runner", () => ({
  DESKTOP_CLAUDE_AGENT_REASON: "desktop unavailable",
  defaultTools: (opts: { claudeAgentUnavailable?: string } = {}) => [
    { id: "claude-agent", unavailableReason: opts.claudeAgentUnavailable },
  ],
  ToolRegistry: class {
    constructor(readonly tools: unknown[]) {}
    get(id: string) {
      return this.tools.find((t) => (t as { id: string }).id === id);
    }
  },
  RunnerEngine: class {
    loop = engineLoop;
    shutdown = engineShutdown;
    constructor(...args: unknown[]) {
      constructEngine(...args);
    }
  },
}));

import { boot, isRunnerStartFailure } from "./boot.js";

describe("bin boot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stops the started server if runner construction fails", async () => {
    const server = { stop: vi.fn(async () => {}) };
    const failure = new Error("engine construction failed");
    startServer.mockResolvedValue(server);
    constructEngine.mockImplementation(() => {
      throw failure;
    });
    await expect(boot({ root: "/tmp/boot-test", version: packageVersion })).rejects.toBe(failure);
    expect(server.stop).toHaveBeenCalledOnce();
    expect(isRunnerStartFailure(failure)).toBe(true);
    expect(isRunnerStartFailure(new Error("unrelated"))).toBe(false);
  });

  it("composes server, registry, runner loop, drain, guard release, and server stop", async () => {
    const order: string[] = [];
    const server = { stop: vi.fn(async () => void order.push("server.stop")) };
    engineLoop.mockImplementation(() => order.push("engine.loop"));
    engineShutdown.mockImplementation(async (graceMs: number) => {
      order.push(`engine.shutdown ${graceMs}`);
      return { stopped: ["task-1"], timedOut: true };
    });
    startServer.mockImplementation(async (options) => {
      order.push("server.start");
      expect(options.catalog).toBeTruthy();
      expect(options.runnerRunning?.()).toBe(false);
      return server;
    });
    constructEngine.mockImplementation(() => order.push("engine.create"));
    const guard = {
      acquire: vi.fn(async () => {
        order.push("guard.acquire");
        return true;
      }),
      release: vi.fn(async () => void order.push("guard.release")),
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await boot({
        root: "/tmp/boot-test",
        version: packageVersion,
        guard: guard as never,
        onServer: () => {
          order.push("server.ready");
        },
        onRunner: () => order.push("runner.ready"),
      });
      await result.stop(5000);
      expect(order).toEqual([
        "server.start",
        "server.ready",
        "guard.acquire",
        "engine.create",
        "runner.ready",
        "engine.loop",
        "engine.shutdown 5000",
        "guard.release",
        "server.stop",
      ]);
      expect(log.mock.calls).toEqual([
        ["Stopped running task(s): task-1"],
        ["Grace period of 5000 ms elapsed; exiting anyway"],
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it("uses one registry marked unavailable for the desktop Claude Agent tool", async () => {
    const server = { stop: vi.fn(async () => {}) };
    startServer.mockImplementation(async (options) => {
      (globalThis as { catalog?: unknown }).catalog = options.catalog;
      return server;
    });
    constructEngine.mockImplementation(() => {});
    const result = await boot({
      root: "/tmp/boot-test",
      version: packageVersion,
      claudeAgent: "unavailable",
    });
    expect(
      (
        globalThis as { catalog?: { get(id: string): { unavailableReason?: string } } }
      ).catalog?.get("claude-agent")?.unavailableReason,
    ).toBe("desktop unavailable");
    expect(constructEngine).toHaveBeenCalledWith(
      expect.objectContaining({ registry: (globalThis as { catalog?: unknown }).catalog }),
    );
    await result.stop(0);
    delete (globalThis as { catalog?: unknown }).catalog;
  });
});
