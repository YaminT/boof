import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSettings, readEvents, type Settings } from "@boof/heart";
import { PoolGate } from "./pool-gate.js";

let root: string;
let server: Server;
let url: string;
let hits: number;
let health: { status: number; body: object };
let clock: number;
let sleeps: number[];

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
const POOL_DOWN = (next: string | null = null) => ({
  status: 503,
  body: {
    status: "degraded",
    pool: {
      configured: 2,
      routable: 0,
      paused: 0,
      rate_limited: 2,
      usage_exhausted: 0,
      next_available_at: next,
    },
  },
});

let settings: Settings;
const poolEvents = async () =>
  (await readEvents(root, null))
    .map((s) => s.event)
    .filter((e) => e.type === "runner.pool_exhausted");
const gate = (over: Partial<ConstructorParameters<typeof PoolGate>[0]> = {}) =>
  new PoolGate({
    root,
    loadSettings: async () => settings,
    readKey: async () => "btr-key",
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms; // a fake clock: waiting advances time, no real delay
    },
    ...over,
  });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-poolgate-"));
  hits = 0;
  clock = Date.parse("2026-11-03T10:00:00Z");
  sleeps = [];
  health = { status: 200, body: POOL_OK };
  server = createServer((req, res) => {
    if (req.url === "/health") {
      hits += 1;
      res
        .writeHead(health.status, { "content-type": "application/json" })
        .end(JSON.stringify(health.body));
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  settings = { ...defaultSettings(), owlish: { url, healthGate: "pause" } };
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("policy and gateway", () => {
  it("absent: no gateway, never blocks, no request", async () => {
    settings = defaultSettings();
    const g = gate();
    expect(await g.gateway()).toBeUndefined();
    expect(await g.check()).toMatchObject({ blocked: false, pool: { status: "absent" } });
    expect(hits).toBe(0);
  });

  it("the gateway carries the url and the key; the key is read each time", async () => {
    expect(await gate().gateway()).toEqual({ url, apiKey: "btr-key" });
    expect(await gate({ readKey: async () => null }).gateway()).toEqual({ url, apiKey: undefined });
    expect(
      await gate({
        readKey: async () => {
          throw new Error("damaged");
        },
      }).gateway(),
    ).toEqual({ url, apiKey: undefined });
  });

  it("pause blocks routed work when degraded, unhealthy or unreachable, not when ok", async () => {
    expect((await gate().check()).blocked).toBe(false);
    for (const [status, body] of [
      [503, { status: "unhealthy", pool: {} }],
      [503, POOL_DOWN().body],
    ] as const) {
      health = { status, body };
      const r = await gate().check();
      expect(r.blocked).toBe(true);
      expect(r.pool.reason).toBeTruthy();
    }
    settings = { ...settings, owlish: { url: "http://127.0.0.1:1", healthGate: "pause" } };
    expect(await gate().check()).toMatchObject({ blocked: true, pool: { status: "unreachable" } });
  });

  it("warn reports the status but never blocks; off does not even ask", async () => {
    health = POOL_DOWN();
    settings = { ...settings, owlish: { url, healthGate: "warn" } };
    expect(await gate().check()).toMatchObject({ blocked: false, pool: { status: "degraded" } });
    hits = 0;
    settings = { ...settings, owlish: { url, healthGate: "off" } };
    expect(await gate().check()).toMatchObject({ blocked: false });
    expect(hits).toBe(0);
  });
});

describe("polling", () => {
  it("asks at most every 30 seconds however often it is consulted", async () => {
    health = POOL_DOWN();
    const g = gate();
    for (let i = 0; i < 50; i++) {
      await g.check();
      clock += 500; // a busy engine loop
    }
    expect(hits).toBe(1);
    clock += 31_000;
    await g.check();
    expect(hits).toBe(2);
  });

  it("goes to the gateway again when a known nextAvailableAt has passed", async () => {
    health = POOL_DOWN(new Date(clock + 60_000).toISOString());
    const g = gate();
    await g.check();
    clock += 20_000; // 20 s: not yet 30 s, and next is still in the future
    await g.check();
    expect(hits).toBe(1);
    clock += 41_000; // past next_available_at
    health = { status: 200, body: POOL_OK };
    expect((await g.check()).blocked).toBe(false);
    expect(hits).toBe(2);
  });
});

describe("episodes", () => {
  it("announces one runner.pool_exhausted per blocked episode and again after recovery", async () => {
    const g = gate();
    health = POOL_DOWN();
    for (let i = 0; i < 3; i++) {
      await g.announceIfBlocked(await g.check());
      clock += 31_000;
    }
    let events = await poolEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "degraded", by: "runner" });
    // Recovery clears the marker...
    health = { status: 200, body: POOL_OK };
    await g.announceIfBlocked(await g.check());
    clock += 31_000;
    // ...so the next outage is a new episode.
    health = POOL_DOWN();
    await g.announceIfBlocked(await g.check());
    events = await poolEvents();
    expect(events).toHaveLength(2);
  });

  it("the event never carries the key", async () => {
    health = POOL_DOWN();
    const g = gate();
    await g.announceIfBlocked(await g.check());
    expect(JSON.stringify(await readEvents(root, null))).not.toContain("btr-key");
  });
});

describe("waitHealthy", () => {
  it("returns at once when healthy", async () => {
    expect(await gate().waitHealthy({ maxMs: 60_000 })).toMatchObject({ ok: true });
    expect(sleeps).toEqual([]);
  });

  it("waits in 30-second polls and returns when the pool recovers, never a tight loop", async () => {
    health = POOL_DOWN();
    const logs: string[] = [];
    const g = gate();
    let calls = 0;
    const res = await g.waitHealthy({
      maxMs: 30 * 60_000,
      log: async (l) => void logs.push(l),
      beforeEachWait: async () => {
        calls += 1;
        if (calls === 4) health = { status: 200, body: POOL_OK }; // recovers during the 4th wait
      },
    });
    expect(res.ok).toBe(true);
    expect(sleeps.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(250); // stop checks stay responsive
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(30_000);
    expect(logs.join("\n")).toMatch(/Waiting for the account pool/);
    expect(hits).toBeLessThanOrEqual(6); // polled about every 30 s, not every sleep tick
  });

  it("shows when the next account is available", async () => {
    health = POOL_DOWN("2026-11-04T00:00:00Z");
    const logs: string[] = [];
    await gate().waitHealthy({ maxMs: 1000, log: async (l) => void logs.push(l) });
    expect(logs.join("\n")).toContain("next available 2026-11-04T00:00:00.000Z");
  });

  it("times out after maxMs and says so", async () => {
    health = POOL_DOWN();
    const res = await gate().waitHealthy({ maxMs: 5 * 60_000 });
    expect(res).toMatchObject({ ok: false });
    expect(res.pool.status).toBe("degraded");
    expect(clock - Date.parse("2026-11-03T10:00:00Z")).toBeGreaterThanOrEqual(5 * 60_000);
    expect(clock - Date.parse("2026-11-03T10:00:00Z")).toBeLessThan(5 * 60_000 + 31_000);
  });

  it("stops waiting when the caller throws (a stop request)", async () => {
    health = POOL_DOWN();
    await expect(
      gate().waitHealthy({
        maxMs: 60 * 60_000,
        beforeEachWait: async () => {
          throw new Error("Task stopped by user");
        },
      }),
    ).rejects.toThrow(/stopped/);
  });

  it("checks stop during a wait at no more than 250 ms intervals", async () => {
    health = POOL_DOWN();
    let checks = 0;
    await expect(
      gate().waitHealthy({
        maxMs: 60_000,
        beforeEachWait: async () => {
          if (++checks === 3) throw new Error("Task stopped by user");
        },
      }),
    ).rejects.toThrow(/stopped/);
    expect(checks).toBe(3);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(250);
  });
});
