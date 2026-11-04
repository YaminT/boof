import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDispatcherWhileHolding } from "./webhooks.js";

let dir: string;
let lock: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boof-runner-gate-"));
  lock = join(dir, "webhooks", ".dispatcher.lock");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const fake = () => {
  const calls: string[] = [];
  return { calls, start: () => void calls.push("start"), stop: () => void calls.push("stop") };
};
/** A dispatcher whose stop() takes a while, like one waiting for a delivery in flight. */
const slowStop = (ms: number) => {
  const calls: string[] = [];
  return {
    calls,
    start: () => void calls.push("start"),
    stop: async () => {
      calls.push("stop begins");
      await new Promise((r) => setTimeout(r, ms));
      calls.push("stop ends");
    },
  };
};
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("runDispatcherWhileHolding", () => {
  it("starts the dispatcher only while it holds the lock, one holder at a time", async () => {
    const a = fake();
    const b = fake();
    const gateA = runDispatcherWhileHolding(a, lock, { retryMs: 30 });
    await gateA.ready;
    const gateB = runDispatcherWhileHolding(b, lock, { retryMs: 30 });
    await gateB.ready;
    expect(a.calls).toEqual(["start"]);
    expect(b.calls).toEqual([]);
    await new Promise((r) => setTimeout(r, 150)); // B keeps retrying, still refused
    expect(b.calls).toEqual([]);
    // A exits: B takes over at its next retry.
    await gateA.stop();
    expect(a.calls).toEqual(["start", "stop"]);
    await until(() => b.calls.includes("start"));
    await gateB.stop();
    expect(b.calls).toEqual(["start", "stop"]);
    await expect(stat(lock)).rejects.toThrow(); // released
  });

  it("releases the lock only after the dispatcher has stopped (a tick in flight finishes first)", async () => {
    const a = slowStop(200);
    const gateA = runDispatcherWhileHolding(a, lock, { retryMs: 20 });
    await gateA.ready;
    const b = fake();
    const gateB = runDispatcherWhileHolding(b, lock, { retryMs: 20 });
    const stopping = gateA.stop();
    await new Promise((r) => setTimeout(r, 120)); // A is still stopping; B retried several times
    expect(b.calls).toEqual([]); // it could not take over while A's delivery might still run
    await stopping;
    expect(a.calls).toEqual(["start", "stop begins", "stop ends"]);
    await until(() => b.calls.includes("start"));
    await gateB.stop();
  });

  it("a gate stopped before it ever got the lock never starts, and stop is idempotent", async () => {
    const a = fake();
    const b = fake();
    const gateA = runDispatcherWhileHolding(a, lock, { retryMs: 30 });
    await gateA.ready;
    const gateB = runDispatcherWhileHolding(b, lock, { retryMs: 30 });
    await gateB.stop();
    await gateB.stop();
    await gateA.stop();
    await new Promise((r) => setTimeout(r, 120));
    expect(b.calls).toEqual([]);
  });

  it("a stop that arrives while the first attempt is in flight leaves nothing held", async () => {
    const a = fake();
    const gate = runDispatcherWhileHolding(a, lock, { retryMs: 30 });
    await gate.stop(); // before ready
    await gate.ready;
    await new Promise((r) => setTimeout(r, 60));
    expect(a.calls.filter((c) => c === "start").length).toBe(
      a.calls.filter((c) => c === "stop").length,
    );
    await expect(stat(lock)).rejects.toThrow();
  });
});
