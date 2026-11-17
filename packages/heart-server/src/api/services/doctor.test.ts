import { describe, expect, it } from "vitest";
import { POOL_TERMS_NOTE, poolCheck, type PoolCheckInput } from "./doctor.js";

const pool = (p: Partial<PoolCheckInput["pool"]> = {}): PoolCheckInput["pool"] => ({
  status: "ok",
  configured: 2,
  routable: 2,
  nextAvailableAt: null,
  reason: null,
  ...p,
});
const check = (i: Partial<PoolCheckInput>) =>
  poolCheck({
    mode: "internal",
    anyReady: true,
    pool: pool(),
    legacyMessage: (s, r) => r ?? `legacy ${s}`,
    ...i,
  });

describe("the account pool Doctor check (plan section 4 table)", () => {
  it("none: warn with an agent ready, fail without one", () => {
    const c = check({ mode: "none", pool: pool({ status: "absent", configured: null }) });
    expect(c).toMatchObject({
      id: "gateway",
      label: "Account pool",
      status: "warn",
      message: "No account pool; agents use their own sign-in.",
      fixPage: "gateway",
    });
    expect(check({ mode: "none", anyReady: false }).status).toBe("fail");
  });

  it("internal without accounts: warn, add an API key", () => {
    expect(
      check({ pool: pool({ configured: 0, routable: 0, status: "unhealthy" }) }),
    ).toMatchObject({
      status: "warn",
      message: "No accounts yet.",
      fixHint: "Add an Anthropic API key.",
      fixPage: "gateway",
    });
  });

  it("internal with every account paused or limited: warn with the reset time", () => {
    const c = check({
      pool: pool({ routable: 0, status: "unhealthy", nextAvailableAt: "2026-01-01T01:00:00.000Z" }),
    });
    expect(c.status).toBe("warn");
    expect(c.message).toBe(
      "All 2 accounts are paused or limited; the first is usable again at 2026-01-01T01:00:00.000Z.",
    );
    expect(check({ pool: pool({ configured: 1, routable: 0 }) }).message).toBe(
      "All 1 account is paused or limited.",
    );
  });

  it("internal with a usable account: pass, N of M", () => {
    expect(check({ pool: pool({ routable: 1, status: "degraded" }) })).toMatchObject({
      status: "pass",
      message: "1 of 2 accounts usable",
    });
    expect(check({ pool: pool({ configured: 1, routable: 1 }) }).message).toBe(
      "1 of 1 account usable",
    );
  });

  it("better-ccflare: today's messages and label", () => {
    expect(check({ mode: "better-ccflare", pool: pool({ status: "ok" }) })).toMatchObject({
      label: "better-ccflare gateway",
      status: "pass",
      message: "legacy ok",
    });
    expect(
      check({ mode: "better-ccflare", pool: pool({ status: "degraded", reason: "r" }) }),
    ).toMatchObject({
      status: "warn",
      message: "r",
      fixPage: "gateway",
    });
    expect(check({ mode: "better-ccflare", pool: pool({ status: "unreachable" }) })).toMatchObject({
      status: "fail",
      fixHint: "Check the gateway address and that it is running.",
    });
  });

  it("every mode carries the terms note", () => {
    for (const mode of ["none", "internal", "better-ccflare"] as const)
      expect(check({ mode }).note).toBe(POOL_TERMS_NOTE);
    expect(POOL_TERMS_NOTE).toMatch(/API keys only/);
    expect(POOL_TERMS_NOTE).toMatch(/subscription sign-ins/);
  });
});
