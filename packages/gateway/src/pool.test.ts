import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountsStore } from "./accounts-store.js";
import { CREDIT_RECHECK_MS } from "./limits.js";
import { Pool, type Strategy } from "./pool.js";

const key = (n: string) => `sk-ant-api03-${n.padEnd(20, "x")}`;
const track = (pool: Pool): Pool => {
  opened.push(pool);
  return pool;
};
let root: string;
let store: AccountsStore;
let now: number;
const clock = () => now;
const advance = (ms: number) => (now += ms);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gateway-pool-"));
  store = new AccountsStore(join(root, "gateway"));
  now = Date.parse("2026-01-01T00:00:00Z");
});
const opened: Pool[] = [];
afterEach(async () => {
  // Writes queued by pick/report run behind the call; let them finish before removing the dir.
  await Promise.all(opened.splice(0).map((p) => p.flush()));
  await rm(root, { recursive: true, force: true });
});

async function open(strategy?: Strategy, ids = ["a", "b", "c"]) {
  let i = 0;
  return track(await Pool.open({ store, now: clock, strategy, newId: () => ids[i++] ?? `id${i}` }));
}

/** Three accounts a(0) b(1) c(2); each add advances the clock so createdAt orders them. */
async function three(strategy?: Strategy) {
  const pool = await open(strategy);
  for (const [n, p] of [
    ["a", 0],
    ["b", 1],
    ["c", 2],
  ] as const) {
    await pool.add({ name: n, apiKey: key(n), priority: p });
    advance(1);
  }
  return pool;
}

describe("ordered strategy", () => {
  it("picks the lowest priority number and sticks to it", async () => {
    const pool = await three();
    for (let i = 0; i < 4; i++) expect(pool.pick()?.id).toBe("a");
    expect(pool.pick()?.apiKey).toBe(key("a"));
  });

  it("moves on when the account fails and returns when it recovers", async () => {
    const pool = await three();
    expect(pool.pick()?.id).toBe("a");
    pool.report("a", { kind: "rate_limited", until: now + 30_000 }, 429);
    expect(pool.pick()?.id).toBe("b");
    expect(pool.pick()?.id).toBe("b");
    advance(30_000);
    expect(pool.pick()?.id).toBe("a");
  });

  it("sticks to the last used account among equal priorities", async () => {
    const pool = await open("ordered", ["x", "y"]);
    await pool.add({ name: "x", apiKey: key("x"), priority: 5 });
    advance(1);
    await pool.add({ name: "y", apiKey: key("y"), priority: 5 });
    expect(pool.pick()?.id).toBe("x");
    pool.report("x", { kind: "rate_limited", until: now + 1000 });
    expect(pool.pick()?.id).toBe("y");
    advance(1000);
    expect(pool.pick()?.id).toBe("y");
  });

  it("honours exclude for failover within one request", async () => {
    const pool = await three();
    expect(pool.pick(["a"])?.id).toBe("b");
    expect(pool.pick(["a", "b", "c"])).toBeNull();
  });
});

describe("round-robin strategy", () => {
  it("rotates across usable accounts and skips unusable ones", async () => {
    const pool = await three("round-robin");
    expect([1, 2, 3, 4].map(() => pool.pick()?.id)).toEqual(["a", "b", "c", "a"]);
    pool.report("b", { kind: "auth" });
    expect([1, 2, 3].map(() => pool.pick()?.id)).toEqual(["c", "a", "c"]);
  });
});

describe("limits and pauses", () => {
  it("skips paused, limited and exhausted accounts", async () => {
    const pool = await three();
    await pool.pause("a");
    pool.report("b", { kind: "rate_limited", until: now + 5000 });
    expect(pool.pick()?.id).toBe("c");
    pool.report("c", { kind: "credit" });
    expect(pool.pick()).toBeNull();
  });

  it("pauses an auth failure until resume", async () => {
    const pool = await three();
    pool.report("a", { kind: "auth" }, 401);
    advance(10 * 24 * 3_600_000);
    expect(pool.accountList()[0]).toMatchObject({ id: "a", paused: true, pauseReason: "auth" });
    expect(pool.pick()?.id).toBe("b");
    await pool.resume("a");
    expect(pool.pick()?.id).toBe("a");
  });

  it("rechecks a credit-exhausted account after the recheck window", async () => {
    const pool = await three();
    pool.report("a", { kind: "credit" });
    expect(pool.pick()?.id).toBe("b");
    advance(CREDIT_RECHECK_MS - 1);
    expect(pool.pick()?.id).toBe("b");
    advance(1);
    expect(pool.pick()?.id).toBe("a");
  });

  it("transient and other outcomes do not penalise the account", async () => {
    const pool = await three();
    pool.report("a", { kind: "transient" }, 529);
    pool.report("a", { kind: "other" }, 400);
    expect(pool.pick()?.id).toBe("a");
    expect(pool.accountList()[0]).toMatchObject({ rateLimitStatus: "allowed", paused: false });
  });

  it("counts usage and requests only", async () => {
    const pool = await three();
    pool.pick();
    pool.pick();
    pool.recordUsage("a", { inputTokens: 10, outputTokens: 5.9 });
    pool.recordUsage("a", { inputTokens: -3, outputTokens: Number.NaN });
    expect(pool.accountList()[0]).toMatchObject({ requestCount: 2 });
    await pool.flush();
    const saved = (await store.loadState()).get("a");
    expect(saved).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });
});

describe("PoolStatus built from state", () => {
  it("is absent with no accounts", async () => {
    const pool = await open();
    expect(pool.status()).toMatchObject({ status: "absent", configured: 0, routable: 0 });
  });

  it("is ok when every account can take traffic", async () => {
    const pool = await three();
    expect(pool.status()).toEqual({
      status: "ok",
      configured: 3,
      routable: 3,
      paused: 0,
      rateLimited: 0,
      usageExhausted: 0,
      nextAvailableAt: null,
      reason: null,
    });
  });

  it("is degraded when some are unavailable", async () => {
    const pool = await three();
    await pool.pause("a");
    pool.report("b", { kind: "rate_limited", until: now + 5000 });
    const s = pool.status();
    expect(s).toMatchObject({
      status: "degraded",
      configured: 3,
      routable: 1,
      paused: 1,
      rateLimited: 1,
    });
    expect(s.nextAvailableAt).toBeNull();
    expect(s.reason!.length).toBeLessThanOrEqual(200);
  });

  it("is unhealthy with the earliest reset when none can take traffic", async () => {
    const pool = await three();
    const soon = now + 20_000;
    pool.report("a", { kind: "rate_limited", until: now + 50_000 });
    pool.report("b", { kind: "rate_limited", until: soon });
    pool.report("c", { kind: "credit" });
    const s = pool.status();
    expect(s).toMatchObject({
      status: "unhealthy",
      routable: 0,
      rateLimited: 2,
      usageExhausted: 1,
      nextAvailableAt: new Date(soon).toISOString(),
    });
    advance(20_000);
    expect(pool.status()).toMatchObject({ status: "degraded", rateLimited: 1 });
    advance(30_000);
    expect(pool.status()).toMatchObject({ status: "degraded", routable: 2 });
  });

  it("has no reset time when all accounts are paused by hand", async () => {
    const pool = await three();
    for (const id of ["a", "b", "c"]) await pool.pause(id);
    expect(pool.status()).toMatchObject({ status: "unhealthy", paused: 3, nextAvailableAt: null });
  });

  it("counts are disjoint and add up", async () => {
    const pool = await three();
    await pool.pause("a");
    pool.report("a", { kind: "rate_limited", until: now + 9000 });
    pool.report("b", { kind: "credit" });
    pool.report("b", { kind: "rate_limited", until: now + 9000 });
    const s = pool.status();
    expect(s.paused! + s.rateLimited! + s.usageExhausted! + s.routable!).toBe(s.configured);
  });
});

describe("persistence and admin", () => {
  it("state survives a restart", async () => {
    const pool = await three();
    pool.pick();
    pool.report("a", { kind: "rate_limited", until: now + 60_000 }, 429);
    await pool.pause("c");
    await pool.flush();
    const again = track(await Pool.open({ store, now: clock }));
    expect(again.accountList().map((a) => [a.id, a.paused, a.rateLimitStatus])).toEqual([
      ["a", false, "rate_limited"],
      ["b", false, "allowed"],
      ["c", true, "allowed"],
    ]);
    expect(again.pick()?.id).toBe("b");
    advance(60_000);
    expect(again.pick()?.id).toBe("a");
  });

  it("validates add, rejects duplicates, removes and re-prioritises", async () => {
    const pool = await open();
    await expect(pool.add({ name: "", apiKey: key("a") })).rejects.toThrow(/name/);
    await expect(pool.add({ name: "n", apiKey: "nope" })).rejects.toThrow(/API key/);
    await expect(pool.add({ name: "n", apiKey: key("a"), priority: 101 })).rejects.toThrow(
      /priority/,
    );
    const first = await pool.add({ name: "one", apiKey: key("a") });
    const second = await pool.add({ name: "two", apiKey: key("b") });
    expect([first.priority, second.priority]).toEqual([0, 1]);
    await expect(pool.add({ name: "again", apiKey: key("a") })).rejects.toThrow(/already/);
    expect(await pool.setPriority(second.id, 0)).toBe(true);
    expect(await pool.remove(first.id)).toBe(true);
    expect(await pool.remove(first.id)).toBe(false);
    expect(pool.accountList().map((a) => a.id)).toEqual([second.id]);
    expect(track(await Pool.open({ store, now: clock })).accountList()).toHaveLength(1);
  });

  it("resume clears waits and unknown ids are ignored", async () => {
    const pool = await three();
    pool.report("a", { kind: "rate_limited", until: now + 9999 });
    expect(await pool.resume("a")).toBe(true);
    expect(pool.pick()?.id).toBe("a");
    expect(await pool.pause("zzz")).toBe(false);
    pool.report("zzz", { kind: "auth" });
  });
});

describe("consistency", () => {
  const second = async (ids = ["x1", "x2", "x3"]) => {
    let i = 0;
    return track(
      await Pool.open({
        store: new AccountsStore(join(root, "gateway")),
        now: clock,
        newId: () => ids[i++] ?? `y${i}`,
      }),
    );
  };

  it("concurrent remove and add leave memory and disk the same", async () => {
    const pool = await open();
    const a = await pool.add({ name: "a", apiKey: key("a") });
    await pool.add({ name: "b", apiKey: key("b") });
    await Promise.all([pool.remove(a.id), pool.add({ name: "c", apiKey: key("c") })]);
    const disk = (await store.loadAccounts()).map((x) => x.apiKey).sort();
    expect(disk).toEqual([key("b"), key("c")]);
    expect(pool.secrets().sort()).toEqual(disk);
  });

  it("a second pool on the same root removes a key and the first stops using it", async () => {
    const first = await open("ordered", ["a", "b"]);
    const a = await first.add({ name: "a", apiKey: key("a"), priority: 0 });
    await first.add({ name: "b", apiKey: key("b"), priority: 1 });
    const other = await second();
    expect(await other.remove(a.id)).toBe(true);
    expect(first.pick()?.apiKey).toBe(key("b"));
    expect(first.secrets()).toEqual([key("b")]);
    // the first pool's next write must not bring the removed key back
    await first.add({ name: "c", apiKey: key("c") });
    expect((await store.loadAccounts()).map((x) => x.apiKey).sort()).toEqual([key("b"), key("c")]);
  });

  it("an add from a second pool survives the first pool's next add", async () => {
    const first = await open("ordered", ["a", "b"]);
    await first.add({ name: "a", apiKey: key("a") });
    const other = await second();
    await other.add({ name: "from-cli", apiKey: key("cli") });
    expect(first.status().configured).toBe(2);
    await first.add({ name: "b", apiKey: key("b") });
    expect((await store.loadAccounts()).map((x) => x.apiKey).sort()).toEqual(
      [key("a"), key("b"), key("cli")].sort(),
    );
  });

  it("brings an existing gateway directory to 0700", async () => {
    const { chmod, mkdir, stat } = await import("node:fs/promises");
    const dir = join(root, "gateway");
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);
    await open();
    if (process.platform !== "win32") expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("writes counters behind a debounce, a pause at once", async () => {
    const pool = await open("ordered", ["a"]);
    const a = await pool.add({ name: "a", apiKey: key("a") });
    await pool.flush();
    pool.pick();
    expect((await store.loadState()).get(a.id)?.requestCount).toBe(0);
    pool.report(a.id, { kind: "auth" }, 401);
    await pool.flush();
    const saved = (await store.loadState()).get(a.id);
    expect(saved?.paused).toBe(true);
    expect(saved?.requestCount).toBe(1);
  });
});
