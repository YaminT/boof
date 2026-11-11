import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSettings,
  budgetTimeZone,
  execCommand,
  newTask,
  ProjectStore,
  readEvents,
  recordSpend,
  SettingsStore,
  TaskStore,
  taskControlDir,
  taskStopRequestPath,
  type Project,
  type TaskFrontmatter,
} from "@boof/heart";
import { RunnerEngine } from "./engine.js";
import { PoolGate } from "./pool-gate.js";
import { AgentAuthResolver } from "./agent-auth.js";
import { ProjectKeyStore } from "@boof/owlish";
import { MockTool, mockState, resetMock } from "./tools/mock.js";
import { ToolRegistry } from "./tools/registry.js";
import type { RunOptions, Tool } from "./tools/types.js";

// Engine and pipeline against a fake gateway (a local HTTP server) and a fake clock: nothing waits
// for real, and the real gateway is never called.

let dataRoot: string;
const dirs: string[] = [];
let server: Server;
let url: string;
let hits: number;
let healthy: boolean;
let accountOAuth = false;
let accountRequests = 0;
let accountOutageFrom = Number.POSITIVE_INFINITY;
let accountOutageThrough = Number.POSITIVE_INFINITY;
/** When set, the agent-key admin-route probe answers with this status instead of 401. */
let agentProbeStatus: number | null = null;
let clock: number;
let sleeps: number[];
let onSleep: (n: number) => Promise<void>;
let seenGateways: (RunOptions["gateway"] | undefined)[];
let settingsStore: SettingsStore;
let main: Project;

const POOL_OK = {
  status: "ok",
  pool: {
    configured: 2,
    routable: 2,
    paused: 0,
    rate_limited: 0,
    usage_exhausted: 0,
    next_available_at: null,
  },
};
const POOL_DOWN = {
  status: "degraded",
  pool: {
    configured: 2,
    routable: 0,
    paused: 0,
    rate_limited: 2,
    usage_exhausted: 0,
    next_available_at: null,
  },
};

/** The mock under another id, serving the pool, recording the gateway it was handed. */
function pooledMock(): Tool {
  const m = new MockTool();
  return {
    id: "pooled",
    displayName: "Pooled mock",
    defaultModels: ["mock-default"],
    acceptsPool: true,
    get supportsResume() {
      return m.supportsResume;
    },
    detect: () => m.detect(),
    listModels: () => m.listModels(),
    run: async (o) => {
      seenGateways.push(o.gateway);
      return m.run(o);
    },
  };
}

const registry = () => new ToolRegistry([new MockTool(), pooledMock()]);
const gate = () =>
  new PoolGate({
    root: dataRoot,
    loadSettings: () => settingsStore.load(),
    readKey: async () => "btr-admin",
    readAgentKey: async () => "btr-key",
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      await onSleep(sleeps.length);
    },
  });
let engine: RunnerEngine;
const makeEngine = () =>
  (engine = new RunnerEngine({
    root: dataRoot,
    pollIntervalMs: 10,
    registry: registry(),
    pool: gate(),
  }));

async function repo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "boof-owgate-work-")));
  dirs.push(dir);
  const g = (args: string[]) =>
    execCommand("git", args, { launch: { kind: "direct" }, cwd: dir, timeoutMs: 15000 });
  await g(["init", "-b", "main"]);
  await g(["config", "user.email", "t@e.com"]);
  await g(["config", "user.name", "T"]);
  await writeFile(join(dir, "README.md"), "# work\n");
  await g(["add", "."]);
  await g(["commit", "-m", "init"]);
  return dir;
}

const tasks = (p: Project) => new TaskStore(new ProjectStore(dataRoot).dir(p.id));
const fm = (
  id: string,
  tool: "mock" | "pooled",
  over: Partial<TaskFrontmatter> = {},
): TaskFrontmatter =>
  ({
    id,
    title: id,
    status: "pending",
    priority: 50,
    skip: false,
    labels: [],
    command: null,
    attachments: [],
    questions: "none",
    tools: {
      planner: { tool: "mock", model: "mock-default" },
      developer: { tool, model: "mock-default" },
      reviewer: { tool: "mock", model: "mock-default" },
    },
    created: "2026-06-04T10:00:00.000Z",
    updated: "2026-06-04T10:00:00.000Z",
    ...over,
  }) as TaskFrontmatter;
const addTask = (id: string, tool: "mock" | "pooled", body = "Work.") =>
  tasks(main).create(newTask(fm(id, tool), body));
const status = async (id: string) => (await tasks(main).get(id))?.frontmatter.status;
const poolEvents = async () =>
  (await readEvents(dataRoot, null))
    .map((e) => e.event)
    .filter((e) => e.type === "runner.pool_exhausted");

async function configure(gateValue: "pause" | "warn" | "off" = "pause", extra: object = {}) {
  await settingsStore.update({
    owlish: { url, healthGate: gateValue },
    ...extra,
  });
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "boof-owgate-data-"));
  hits = 0;
  accountRequests = 0;
  accountOutageFrom = Number.POSITIVE_INFINITY;
  accountOutageThrough = Number.POSITIVE_INFINITY;
  agentProbeStatus = null;
  healthy = true;
  clock = Date.parse("2026-11-03T10:00:00Z");
  sleeps = [];
  onSleep = async () => {};
  seenGateways = [];
  server = createServer((req, res) => {
    if (req.url === "/api/accounts") {
      const key = String(req.headers["x-api-key"] ?? "");
      // The agent-key probe is not an eligibility check. An api-only key is refused here.
      if ((/agent/i.test(key) && !/admin/i.test(key)) || key === "btr-key")
        return void res.writeHead(agentProbeStatus ?? 401).end();
      accountRequests += 1;
      if (accountRequests >= accountOutageFrom && accountRequests <= accountOutageThrough)
        return void res
          .writeHead(503, { "content-type": "application/json" })
          .end("gateway unavailable");
      return void res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify([
          {
            id: "account-1",
            name: accountOAuth ? "Max OAuth" : "Console API",
            provider: accountOAuth ? "anthropic" : "claude-console-api",
            hasRefreshToken: accountOAuth,
          },
        ]),
      );
    }
    if (req.url !== "/health") return void res.writeHead(404).end();
    hits += 1;
    res
      .writeHead(healthy ? 200 : 503, { "content-type": "application/json" })
      .end(JSON.stringify(healthy ? POOL_OK : POOL_DOWN));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  settingsStore = new SettingsStore(dataRoot);
  await settingsStore.save({ ...defaultSettings(), runner: { enabled: true, concurrency: 1 } });
  main = await new ProjectStore(dataRoot).create({ workingDirectory: await repo(), id: "main" });
  resetMock();
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  for (const d of dirs.splice(0))
    await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  resetMock();
});

describe("selection", () => {
  it("keeps Agent SDK tasks pending when eligibility is unreachable", async () => {
    await configure();
    accountOutageFrom = 1;
    const auth = new AgentAuthResolver({
      root: dataRoot,
      loadSettings: () => settingsStore.load(),
      readGatewayKey: async () => "client-key",
      readAgentKey: async () => "agent-key",
    });
    const agent = new MockTool();
    const registry = new ToolRegistry([
      new MockTool(),
      {
        id: "claude-agent",
        displayName: "Claude Agent",
        defaultModels: ["default"],
        needsAgentAuth: true,
        detect: async () => ({ status: "available", message: "test" }),
        listModels: async () => ["default"],
        run: (opts) => agent.run(opts),
      },
    ]);
    await tasks(main).create(
      newTask(
        fm("t-outage-pending", "mock", {
          tools: {
            planner: { tool: "mock", model: "mock-default" },
            developer: { tool: "claude-agent", model: "default" },
            reviewer: { tool: "mock", model: "mock-default" },
          },
        }),
        "Work.",
      ),
    );
    engine = new RunnerEngine({ root: dataRoot, registry, pool: gate(), agentAuth: auth });
    expect((await engine.tick()).kind).toBe("idle");
    expect(await status("t-outage-pending")).toBe("pending");
  });

  it("desktop unavailability wins before auth even with a project key and configured gateway", async () => {
    await configure();
    await new ProjectKeyStore(dataRoot).set(main.id, "sk-ant-api03-abcdefghijklmnop");
    const registry = new ToolRegistry([
      new MockTool(),
      {
        id: "claude-agent",
        displayName: "Claude Agent",
        defaultModels: ["default"],
        needsAgentAuth: true,
        unavailableReason: "desktop Claude Agent SDK unavailable",
        detect: async () => ({ status: "unavailable", message: "unavailable" }),
        listModels: async () => ["default"],
        run: async () => ({ output: "unused", report: "unused" }),
      },
    ]);
    await tasks(main).create(
      newTask(
        fm("t-desktop-race", "mock", {
          tools: {
            planner: { tool: "mock", model: "mock-default" },
            developer: { tool: "mock", model: "mock-default" },
            reviewer: { tool: "claude-agent", model: "default" },
          },
        }),
        "Work.",
      ),
    );
    engine = new RunnerEngine({ root: dataRoot, registry });
    await engine.tick();
    expect((await tasks(main).get("t-desktop-race"))?.body.log).toContain(
      "desktop Claude Agent SDK unavailable",
    );
    expect(accountRequests).toBe(0);
  });

  it("refuses after a pool wait when the real resolver sees a newly added OAuth account", async () => {
    await configure();
    const toolRuns: unknown[] = [];
    const registry = new ToolRegistry([
      new MockTool(),
      {
        id: "claude-agent",
        displayName: "Claude Agent",
        defaultModels: ["default"],
        needsAgentAuth: true,
        detect: async () => ({ status: "ok", message: "test" }),
        listModels: async () => ["default"],
        run: async (opts) => {
          toolRuns.push(opts);
          return { output: "ok", report: "ok" };
        },
      },
    ]);
    const auth = new AgentAuthResolver({
      root: dataRoot,
      loadSettings: () => settingsStore.load(),
      readGatewayKey: async () => "client-key",
      readAgentKey: async () => "agent-key",
    });
    let injectedOAuth = false;
    const realPool = new PoolGate({
      root: dataRoot,
      loadSettings: () => settingsStore.load(),
      readKey: async () => "client-key",
      readAgentKey: async () => "agent-key",
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (!injectedOAuth) {
          injectedOAuth = true;
          accountOAuth = true;
          healthy = true;
        }
      },
    });
    let degradedAfterPlanner = false;
    mockState.onRun = async (opts) => {
      if (opts.role === "planner" && !degradedAfterPlanner) {
        degradedAfterPlanner = true;
        healthy = false;
      }
    };
    await tasks(main).create(
      newTask(
        fm("t-auth-flip", "mock", {
          tools: {
            planner: { tool: "mock", model: "mock-default" },
            developer: { tool: "claude-agent", model: "default" },
            reviewer: { tool: "mock", model: "mock-default" },
          },
        }),
        "Work.",
      ),
    );
    engine = new RunnerEngine({ root: dataRoot, registry, pool: realPool, agentAuth: auth });
    const result = await engine.tick();
    expect(result.kind).toBe("ran");
    const task = await tasks(main).get("t-auth-flip");
    expect(task?.frontmatter.status).toBe("failed");
    const refusal =
      `claude-agent cannot start: the better-ccflare gateway would route to subscription accounts (Max OAuth). ` +
      `Anthropic allows the Agent SDK only with API-key authentication; subscription (OAuth) accounts stay on the claude-code CLI. ` +
      `Set an Anthropic API key for project "${main.name}" (Settings › Project), or use claude-code for this role.`;
    expect(task?.body.log).toContain(refusal);
    expect(toolRuns).toHaveLength(0);
    expect(existsSync(join(main.workingDirectory, ".boof-runner-worktrees", "t-auth-flip"))).toBe(
      true,
    );
    await engine.tick();
    expect(
      (await readEvents(dataRoot, null)).filter(
        (row) => row.event.type === "runner.agent_auth_refused",
      ),
    ).toHaveLength(1);
    accountOAuth = false;
    healthy = true;
    await tasks(main).transition("t-auth-flip", "pending");
    const retried = await engine.tick();
    expect(retried.kind).toBe("ran");
    expect(await status("t-auth-flip")).toBe("done");
    expect(toolRuns).toHaveLength(1);
  });

  it("waits through an eligibility 5xx, then runs after gateway recovery", async () => {
    await configure();
    accountOutageFrom = 2;
    accountOutageThrough = 2;
    const toolRuns: RunOptions[] = [];
    const agent = new MockTool();
    const registry = new ToolRegistry([
      new MockTool(),
      {
        id: "claude-agent",
        displayName: "Claude Agent",
        defaultModels: ["default"],
        needsAgentAuth: true,
        detect: async () => ({ status: "available", message: "test" }),
        listModels: async () => ["default"],
        run: async (opts) => {
          toolRuns.push(opts);
          return agent.run(opts);
        },
      },
    ]);
    const auth = new AgentAuthResolver({
      root: dataRoot,
      loadSettings: () => settingsStore.load(),
      readGatewayKey: async () => "client-key",
      readAgentKey: async () => "agent-key",
    });
    await tasks(main).create(
      newTask(
        fm("t-outage-recovery", "mock", {
          tools: {
            planner: { tool: "mock", model: "mock-default" },
            developer: { tool: "claude-agent", model: "default" },
            reviewer: { tool: "mock", model: "mock-default" },
          },
        }),
        "Work.",
      ),
    );
    engine = new RunnerEngine({ root: dataRoot, registry, pool: gate(), agentAuth: auth });
    const result = await engine.tick();
    expect(result.kind).toBe("ran");
    expect(await status("t-outage-recovery")).toBe("done");
    expect(accountRequests).toBe(3);
    expect(toolRuns).toHaveLength(1);
    expect((await tasks(main).get("t-outage-recovery"))?.body.log).toContain(
      "Waiting for the better-ccflare gateway (unreachable)",
    );
  });

  it("fails a running Agent SDK task after the gateway stays unreachable through poolWaitMs", async () => {
    await configure();
    accountOutageFrom = 2;
    accountOutageThrough = Number.POSITIVE_INFINITY;
    await settingsStore.save({
      ...(await settingsStore.load()),
      retries: { ...(await settingsStore.load()).retries, poolWaitMs: 1000 },
    });
    const agent = new MockTool();
    const registry = new ToolRegistry([
      new MockTool(),
      {
        id: "claude-agent",
        displayName: "Claude Agent",
        defaultModels: ["default"],
        needsAgentAuth: true,
        detect: async () => ({ status: "available", message: "test" }),
        listModels: async () => ["default"],
        run: (opts) => agent.run(opts),
      },
    ]);
    const auth = new AgentAuthResolver({
      root: dataRoot,
      loadSettings: () => settingsStore.load(),
      readGatewayKey: async () => "client-key",
      readAgentKey: async () => "agent-key",
    });
    await tasks(main).create(
      newTask(
        fm("t-outage-timeout", "mock", {
          tools: {
            planner: { tool: "mock", model: "mock-default" },
            developer: { tool: "claude-agent", model: "default" },
            reviewer: { tool: "mock", model: "mock-default" },
          },
        }),
        "Work.",
      ),
    );
    engine = new RunnerEngine({ root: dataRoot, registry, pool: gate(), agentAuth: auth });
    const result = await engine.tick();
    expect(result.kind).toBe("ran");
    expect(await status("t-outage-timeout")).toBe("failed");
    expect((await tasks(main).get("t-outage-timeout"))?.body.log).toContain("pool exhausted");
  });

  it("without settings.owlish nothing changes: a pooled task runs, no gateway, no request", async () => {
    await addTask("t1", "pooled");
    makeEngine();
    const results = await engine.runUntilIdle();
    expect(await status("t1")).toBe("done");
    expect(results.at(-1)).toEqual({ kind: "idle" });
    expect(seenGateways.every((g) => g === undefined)).toBe(true);
    expect(seenGateways.length).toBeGreaterThan(0);
    expect(hits).toBe(0);
  });

  it("a gateway outage keeps a pool-routed task pending and does not fail its goal", async () => {
    agentProbeStatus = 503;
    await configure("off");
    await addTask("routed", "pooled");
    await addTask("plain", "mock");
    makeEngine();
    const noteGoalStatus = vi.spyOn(engine as any, "noteGoalTaskStatus");
    const results = await engine.runUntilIdle();
    expect(await status("plain")).toBe("done");
    expect(await status("routed")).toBe("pending");
    expect((await tasks(main).get("routed"))?.body.log ?? "").not.toContain("Not started");
    expect(seenGateways).toEqual([]);
    expect(results.at(-1)).toEqual({
      kind: "pool",
      status: "unreachable",
      reason: "the better-ccflare gateway is unreachable",
    });
    expect(noteGoalStatus.mock.calls.filter((call) => call[2] === "failed")).toEqual([]);
    expect(
      (await readEvents(dataRoot, null)).some(
        (row) => row.event.type === "runner.agent_auth_refused",
      ),
    ).toBe(false);
  });

  it("a pool-routed task is refused when only the admin key is set, and that key is not handed over", async () => {
    await configure();
    await addTask("t1", "pooled");
    engine = new RunnerEngine({
      root: dataRoot,
      pollIntervalMs: 10,
      registry: registry(),
      pool: new PoolGate({
        root: dataRoot,
        loadSettings: () => settingsStore.load(),
        readKey: async () => "btr-admin",
        readAgentKey: async () => null,
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
      }),
    });
    await engine.runUntilIdle();
    expect(await status("t1")).toBe("failed");
    expect(seenGateways).toEqual([]);
    const log = (await tasks(main).get("t1"))?.body.log ?? "";
    expect(log).toMatch(/owlishAgentKey/);
    expect(log).not.toContain("btr-admin");
  });

  it("the same string as admin and agent key is not given to a pool-routed tool", async () => {
    await configure();
    await addTask("t1", "pooled");
    engine = new RunnerEngine({
      root: dataRoot,
      pollIntervalMs: 10,
      registry: registry(),
      pool: new PoolGate({
        root: dataRoot,
        loadSettings: () => settingsStore.load(),
        readKey: async () => "same-secret",
        readAgentKey: async () => "same-secret",
        now: () => clock,
        sleep: async () => {},
      }),
    });
    await engine.runUntilIdle();
    expect(await status("t1")).toBe("failed");
    expect(seenGateways).toEqual([]);
    expect((await tasks(main).get("t1"))?.body.log ?? "").not.toContain("same-secret");
  });

  it("a healthy pool: the pooled task runs and is handed the gateway; the mock role gets none", async () => {
    await configure();
    await addTask("t1", "pooled");
    makeEngine();
    await engine.runUntilIdle();
    expect(await status("t1")).toBe("done");
    expect(seenGateways).toEqual([{ url, apiKey: "btr-key" }]);
    expect(await poolEvents()).toEqual([]);
  });

  it("pause + unusable pool: a task whose roles use a pooled tool stays pending, one that does not still runs", async () => {
    healthy = false;
    await configure();
    await addTask("routed", "pooled");
    await addTask("plain", "mock");
    makeEngine();
    const results = await engine.runUntilIdle();
    expect(await status("plain")).toBe("done");
    expect(await status("routed")).toBe("pending");
    expect(seenGateways).toEqual([]);
    const last = results.at(-1)!;
    expect(last).toMatchObject({ kind: "pool", status: "degraded" });
    expect((last as { reason: string }).reason).toMatch(/degraded/);
    expect(engine.poolBlock()).toMatchObject({ status: "degraded" });
  });

  it("announces one runner.pool_exhausted per episode however many ticks, and polls about every 30 s", async () => {
    healthy = false;
    await configure();
    await addTask("routed", "pooled");
    makeEngine();
    for (let i = 0; i < 40; i++) {
      expect((await engine.tick()).kind).toBe("pool");
      clock += 500;
    }
    expect(await poolEvents()).toHaveLength(1);
    expect(hits).toBe(1);
  });

  it("resumes on its own once health returns, and a later outage is a new episode", async () => {
    healthy = false;
    await configure();
    await addTask("routed", "pooled");
    makeEngine();
    expect((await engine.tick()).kind).toBe("pool");
    healthy = true;
    accountOAuth = false;
    clock += 31_000;
    const res = await engine.tick();
    expect(res.kind).toBe("ran");
    expect(await status("routed")).toBe("done");
    expect(engine.poolBlock()).toBeNull();
    healthy = false;
    clock += 31_000;
    await addTask("routed2", "pooled");
    expect((await engine.tick()).kind).toBe("pool");
    expect(await poolEvents()).toHaveLength(2);
  });

  it("warn does not block; off does not even ask", async () => {
    healthy = false;
    await configure("warn");
    await addTask("a", "pooled");
    makeEngine();
    await engine.runUntilIdle();
    expect(await status("a")).toBe("done");
    expect(await poolEvents()).toEqual([]);
    hits = 0;
    accountOAuth = false;
    accountRequests = 0;
    await configure("off");
    await addTask("b", "pooled");
    makeEngine();
    await engine.runUntilIdle();
    expect(await status("b")).toBe("done");
    expect(hits).toBe(0);
  });
});

describe("a running task and the pool", () => {
  it("checks the day budget again after a successful pre-step pool wait", async () => {
    await configure("pause", { budget: { perDayUsd: 0.5, onExceed: "pause" } });
    await addTask("t1", "pooled");
    mockState.onRun = async (o) => {
      if (o.role === "planner" && mockState.calls.length === 1) {
        healthy = false;
        clock += 31_000;
      }
    };
    onSleep = async (n) => {
      if (n === 1) {
        await recordSpend({
          dataRoot,
          projectId: main.id,
          projectDir: main.workingDirectory,
          tool: "external",
          usage: { costUsd: 1, known: true },
          timezone: budgetTimeZone({}),
        });
        healthy = true;
      }
    };
    makeEngine();
    await engine.runUntilIdle();
    expect(await status("t1")).toBe("failed");
    expect(mockState.calls).toEqual(["planner", "planner"]);
    expect(mockState.calls).not.toContain("developer");
    expect((await tasks(main).get("t1"))?.body.log).toContain("budget exceeded: global");
  });

  it("checks the day budget after a 503 pool wait before rerunning the step", async () => {
    await configure("pause", {
      budget: { perDayUsd: 0.5, onExceed: "pause" },
      retries: { transient: 0, backoffMs: [0], idleTimeoutMs: 1_200_000, poolWaitMs: 600_000 },
    });
    await addTask("t1", "pooled", "Work. [[mock-transient developer=1]]");
    mockState.onRun = async (o) => {
      if (o.role === "developer" && !mockState.transientCounts.get("developer")) healthy = false;
    };
    onSleep = async (n) => {
      if (n === 1) {
        await recordSpend({
          dataRoot,
          projectId: main.id,
          projectDir: main.workingDirectory,
          tool: "external",
          usage: { costUsd: 1, known: true },
          timezone: budgetTimeZone({}),
        });
        healthy = true;
      }
    };
    makeEngine();
    await engine.runUntilIdle();
    expect(await status("t1")).toBe("failed");
    expect(mockState.calls.filter((role) => role === "developer")).toHaveLength(1);
    expect((await tasks(main).get("t1"))?.body.log).toContain("budget exceeded: global");
  });

  it("waits in place before a pooled step while the pool is down, stays running, and finishes when it recovers", async () => {
    await configure("pause");
    await addTask("t1", "pooled");
    const observed: (string | undefined)[] = [];
    // The pool goes down after the first step (planner), with the cache already stale.
    mockState.onRun = async (o) => {
      if (o.role === "planner" && mockState.calls.length === 1) {
        healthy = false;
        clock += 31_000;
      }
    };
    onSleep = async (n) => {
      observed.push(await status("t1"));
      if (n === 3) healthy = true; // recovers on the third wait
    };
    makeEngine();
    await engine.runUntilIdle();
    expect(await status("t1")).toBe("done");
    expect(sleeps.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(250);
    expect(observed.every((s) => s === "running")).toBe(true);
    const t = await tasks(main).get("t1");
    expect(t?.body.log).toContain("### Waiting for the account pool");
    expect(await poolEvents()).toHaveLength(1);
    expect(hits).toBeLessThanOrEqual(8);
  });

  it("fails with pool exhausted after retries.poolWaitMs, keeps the worktree, does not spin", async () => {
    await configure("pause", {
      retries: { transient: 2, backoffMs: [0], idleTimeoutMs: 1_200_000, poolWaitMs: 120_000 },
    });
    await settingsStore.update({ worktree: { onDone: "keep-branch", onFailure: "delete" } });
    await addTask("t1", "pooled");
    mockState.onRun = async (o) => {
      if (o.role === "planner" && mockState.calls.length === 1) {
        healthy = false;
        clock += 31_000;
      }
    };
    makeEngine();
    const results = await engine.runUntilIdle();
    const t = await tasks(main).get("t1");
    expect(t?.frontmatter.status).toBe("failed");
    expect(t?.body.log).toMatch(/pool exhausted/);
    expect(existsSync(join(main.workingDirectory, ".boof-runner-worktrees", "t1"))).toBe(true);
    const waited = sleeps.reduce((a, b) => a + b, 0);
    expect(waited).toBeGreaterThanOrEqual(120_000);
    expect(waited).toBeLessThan(120_000 + 31_000);
    expect(hits).toBeLessThanOrEqual(8); // ~30 s health polls, not a busy loop
    expect(results.some((r) => r.kind === "ran" && r.outcome.kind === "failed")).toBe(true);
  });

  it("a proxy 503 while the pool is down waits for it instead of spending a retry", async () => {
    await configure("pause", {
      retries: { transient: 0, backoffMs: [0], idleTimeoutMs: 1_200_000, poolWaitMs: 600_000 },
    });
    await addTask("t1", "pooled", "Work. [[mock-transient developer=1]]");
    // The developer's first run is the 503; at that moment the gateway reports the pool down.
    mockState.onRun = async (o) => {
      if (o.role === "developer" && !mockState.transientCounts.get("developer")) healthy = false;
    };
    onSleep = async (n) => {
      if (n === 2) healthy = true;
    };
    makeEngine();
    await engine.runUntilIdle();
    // transient: 0 would fail the task on the 503 alone; the pool wait let the step run again.
    expect(await status("t1")).toBe("done");
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    const t = await tasks(main).get("t1");
    expect(t?.body.log).toContain("the account pool is not usable");
  });

  it("a 503 with a healthy pool is an ordinary retry (the pool wait is not involved)", async () => {
    await configure("pause", {
      retries: { transient: 1, backoffMs: [0], idleTimeoutMs: 1_200_000, poolWaitMs: 600_000 },
    });
    await addTask("t1", "pooled", "Work. [[mock-transient developer=1]]");
    makeEngine();
    await engine.runUntilIdle();
    expect(await status("t1")).toBe("done");
    expect(sleeps).toEqual([]);
  });

  it("a stop request ends the wait", async () => {
    await configure("pause");
    await addTask("t1", "pooled");
    mockState.onRun = async (o) => {
      if (o.role === "planner" && mockState.calls.length === 1) {
        healthy = false;
        clock += 31_000;
      }
    };
    onSleep = async (n) => {
      if (n === 2) {
        const dir = new ProjectStore(dataRoot).dir("main");
        await mkdir(taskControlDir(dir, "t1"), { recursive: true });
        await writeFile(taskStopRequestPath(dir, "t1"), "stop\n");
      }
    };
    makeEngine();
    await engine.runUntilIdle();
    expect(await status("t1")).toBe("stopped");
  });
});
