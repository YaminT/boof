import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { SecuritySettings } from "@boof-runner/shared";
import { SecuritySettingsSchema } from "@boof-runner/shared";
import { unauthenticatedRateLimit } from "./rate-limit.js";

const security = async (): Promise<SecuritySettings> =>
  SecuritySettingsSchema.parse({ rateLimit: { unauthenticatedPerMinute: 3 } });

function setup(maxBuckets?: number) {
  let clock = 1_000_000;
  let peer = "10.0.0.1";
  const mw = unauthenticatedRateLimit({
    security,
    peerAddress: () => peer,
    now: () => clock,
    maxBuckets,
  });
  const app = new Hono();
  app.use("*", mw);
  app.get("/", (c) => c.body(null, c.req.header("x-ok") ? 200 : 401));
  const hit = (ok = false) => app.request("/", ok ? { headers: { "x-ok": "1" } } : {});
  return { mw, hit, at: (p: string) => (peer = p), tick: (ms: number) => (clock += ms) };
}

describe("unauthenticatedRateLimit", () => {
  it("a parallel burst of bad keys is capped at the bucket size", async () => {
    const { hit } = setup();
    const res = await Promise.all(Array.from({ length: 8 }, () => hit()));
    expect(res.filter((r) => r.status === 401)).toHaveLength(3);
    expect(res.filter((r) => r.status === 429)).toHaveLength(5);
  });

  it("refunds a valid request; a valid key from a drained address still gets 429", async () => {
    const { hit, tick } = setup();
    for (let i = 0; i < 2; i += 1) await hit();
    for (let i = 0; i < 10; i += 1) expect((await hit(true)).status).toBe(200); // never draws
    expect((await hit()).status).toBe(401); // third charge
    expect((await hit(true)).status).toBe(429); // drained: even a valid key is refused
    tick(60_000);
    expect((await hit(true)).status).toBe(200);
  });

  it("keeps no state for successful requests and stays bounded under a flood", async () => {
    const { mw, hit, at, tick } = setup(100);
    for (let i = 0; i < 500; i += 1) {
      at(`10.1.${i >> 8}.${i & 255}`);
      expect((await hit(true)).status).toBe(200);
    }
    expect(mw.size()).toBe(0);
    for (let i = 0; i < 500; i += 1) {
      at(`10.2.${i >> 8}.${i & 255}`);
      if (i % 50 === 0) tick(60_000);
      await hit();
    }
    expect(mw.size()).toBeLessThanOrEqual(100);
  });
});
