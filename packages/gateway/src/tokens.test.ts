import { describe, expect, it } from "vitest";
import { TOKEN_PREFIX, TokenStore } from "./tokens.js";

function setup() {
  let now = 1_000_000;
  const store = new TokenStore({ now: () => now });
  return { store, advance: (ms: number) => (now += ms) };
}

describe("TokenStore", () => {
  it("mints random 256-bit tokens that verify to their run", () => {
    const { store } = setup();
    const a = store.mint({ runId: "r1", projectId: "p1", ttlMs: 60_000 });
    const b = store.mint({ runId: "r1", ttlMs: 60_000 });
    expect(a).not.toBe(b);
    expect(a.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(Buffer.from(a.slice(TOKEN_PREFIX.length), "base64url")).toHaveLength(32);
    expect(store.verify(a)).toMatchObject({ runId: "r1", projectId: "p1" });
    expect(store.verify(b)).toMatchObject({ runId: "r1", projectId: null });
  });

  it("rejects unknown, empty and malformed tokens", () => {
    const { store } = setup();
    store.mint({ runId: "r1", ttlMs: 1000 });
    expect(store.verify("bgw_unknown")).toBeNull();
    expect(store.verify("")).toBeNull();
    expect(store.verify(undefined)).toBeNull();
    expect(store.verify("x".repeat(1000))).toBeNull();
  });

  it("expires with the injected clock", () => {
    const { store, advance } = setup();
    const t = store.mint({ runId: "r1", ttlMs: 5000 });
    advance(4999);
    expect(store.verify(t)).not.toBeNull();
    advance(1);
    expect(store.verify(t)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("revokes one token or a whole run", () => {
    const { store } = setup();
    const a = store.mint({ runId: "r1", ttlMs: 1000 });
    const b = store.mint({ runId: "r1", ttlMs: 1000 });
    const c = store.mint({ runId: "r2", ttlMs: 1000 });
    expect(store.revoke(a)).toBe(true);
    expect(store.revoke(a)).toBe(false);
    expect(store.verify(a)).toBeNull();
    expect(store.revokeRun("r1")).toBe(1);
    expect(store.verify(b)).toBeNull();
    expect(store.verify(c)).not.toBeNull();
  });

  it("refuses a bad ttl and does not keep the raw token", () => {
    const { store } = setup();
    for (const ttlMs of [0, -1, Number.NaN, 25 * 3_600_000]) {
      expect(() => store.mint({ runId: "r", ttlMs })).toThrow();
    }
    expect(() => store.mint({ runId: "", ttlMs: 1000 })).toThrow();
    const t = store.mint({ runId: "r", ttlMs: 1000 });
    const dump = JSON.stringify([...(store as unknown as { tokens: Map<string, unknown> }).tokens]);
    expect(dump).not.toContain(t);
  });
});
