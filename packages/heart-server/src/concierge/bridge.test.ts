import { describe, expect, it } from "vitest";
import { ConciergeBridgeRegistry, type ConciergeMcpServer } from "./bridge.js";

const make = () => ({}) as ConciergeMcpServer;

describe("ConciergeBridgeRegistry", () => {
  it("offers no endpoint until the server has an address", () => {
    const registry = new ConciergeBridgeRegistry();
    expect(registry.ready).toBe(false);
    expect(() => registry.open(make)).toThrow(/not available/);
    registry.setBaseUrl("http://127.0.0.1:4319/");
    expect(registry.ready).toBe(true);
    registry.setBaseUrl(null);
    expect(registry.ready).toBe(false);
  });

  it("issues a per-turn url and a 256-bit token, and verifies exactly that pair", () => {
    const registry = new ConciergeBridgeRegistry();
    registry.setBaseUrl("http://127.0.0.1:4319/");
    const a = registry.open(make);
    const b = registry.open(make);
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:4319\/mcp\/concierge\/[0-9a-f-]{36}$/);
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.url).not.toBe(b.url);
    const idOf = (url: string) => url.split("/").pop()!;
    expect(registry.verify(idOf(a.url), a.token)).toBe(make);
    expect(registry.verify(idOf(a.url), b.token)).toBeNull();
    expect(registry.verify(idOf(b.url), a.token)).toBeNull();
    expect(registry.verify("no-such-turn", a.token)).toBeNull();
    expect(registry.verify(idOf(a.url), undefined)).toBeNull();
    expect(registry.verify(idOf(a.url), "")).toBeNull();
  });

  it("stops honouring a turn once its lease is closed", () => {
    const registry = new ConciergeBridgeRegistry();
    registry.setBaseUrl("http://127.0.0.1:1");
    const lease = registry.open(make);
    const id = lease.url.split("/").pop()!;
    expect(registry.active).toBe(1);
    lease.close();
    expect(registry.verify(id, lease.token)).toBeNull();
    expect(registry.active).toBe(0);
  });

  it("closes every lease a turn opened", () => {
    const registry = new ConciergeBridgeRegistry();
    registry.setBaseUrl("http://127.0.0.1:1");
    const turn = registry.forTurn(make);
    turn.bridge.open();
    turn.bridge.open();
    expect(registry.active).toBe(2);
    turn.closeAll();
    expect(registry.active).toBe(0);
  });
});
