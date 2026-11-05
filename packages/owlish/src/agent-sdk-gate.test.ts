import { describe, expect, it } from "vitest";
import {
  AGENT_SDK_API_KEY_PROVIDERS,
  agentSdkEligibility,
  decideAgentAuth,
} from "./agent-sdk-gate.js";

const account = (id: string, provider?: string, extra = {}) => ({
  id,
  name: id,
  provider,
  ...extra,
});
const now = new Date("2026-11-05T00:00:00.000Z");

describe("agentSdkEligibility", () => {
  it("allows only known API-key providers without refresh tokens", () => {
    expect([...AGENT_SDK_API_KEY_PROVIDERS]).toHaveLength(15);
    for (const provider of AGENT_SDK_API_KEY_PROVIDERS) {
      expect(agentSdkEligibility([account(provider, provider)], now).allowed, provider).toBe(true);
    }
  });
  it.each(["anthropic", "codex", "codebuddy", "qwen", "xai"])(
    "blocks %s, including paused and mixed accounts",
    (provider) => {
      for (const accounts of [
        [account("named", provider, { paused: true })],
        [account("named", provider), account("api", "claude-console-api")],
      ]) {
        const result = agentSdkEligibility(accounts, now);
        expect(result.allowed).toBe(false);
        expect(result.blocking[0]).toMatchObject({ name: "named", why: "subscription" });
        expect(result.reason).toContain("named");
      }
    },
  );
  it("blocks refresh tokens and unknown providers", () => {
    expect(
      agentSdkEligibility([account("oauth", "bedrock", { hasRefreshToken: true })], now).blocking[0]
        ?.why,
    ).toBe("oauth-token");
    for (const provider of ["", undefined, "future-thing"]) {
      expect(agentSdkEligibility([account("unknown", provider)], now).blocking[0]?.why).toBe(
        "unknown-type",
      );
    }
  });
  it("fails closed for unreadable and empty pools and bounds blocking detail", () => {
    for (const detail of ["HTTP 401", "unreachable", "malformed answer"]) {
      expect(agentSdkEligibility(null, now, detail).reason).toContain(detail);
    }
    expect(agentSdkEligibility([], now).allowed).toBe(false);
    const many = agentSdkEligibility(
      Array.from({ length: 50 }, (_, i) => account(`blocked-${i}`, "anthropic")),
      now,
    );
    expect(many.blocking).toHaveLength(20);
    expect(many.reason.length).toBeLessThanOrEqual(300);
    expect(many.reason).toContain("50 subscription accounts");
    expect(many.reason).not.toContain("blocked-0");
    const injected = agentSdkEligibility(
      [account("safe", "anthropic", { name: "evil\n\u0000name" })],
      now,
    );
    expect(injected.blocking[0]?.name).toBe("evil  name");
  });
});

describe("decideAgentAuth", () => {
  const allowed = agentSdkEligibility([account("console", "claude-console-api")], now);
  const denied = agentSdkEligibility([account("alice-max", "anthropic")], now);
  it("implements the four decisions and exact refusal copy", () => {
    expect(
      decideAgentAuth({
        projectName: "p",
        choice: "project-key",
        gatewayConfigured: false,
        eligibility: null,
        hasProjectKey: true,
      }),
    ).toEqual({ ok: true, via: "project-key", note: null });
    expect(
      decideAgentAuth({
        projectName: "p",
        choice: "gateway",
        gatewayConfigured: true,
        eligibility: allowed,
        hasProjectKey: false,
      }),
    ).toEqual({ ok: true, via: "gateway", note: null });
    expect(
      decideAgentAuth({
        projectName: "p",
        choice: "gateway",
        gatewayConfigured: true,
        eligibility: denied,
        hasProjectKey: true,
      }),
    ).toMatchObject({
      ok: true,
      via: "project-key",
      note: expect.stringContaining("using the project's API key"),
    });
    const refusal = decideAgentAuth({
      projectName: "My project",
      choice: "gateway",
      gatewayConfigured: false,
      eligibility: null,
      hasProjectKey: false,
    });
    expect(refusal).toEqual({
      ok: false,
      reason:
        'claude-agent cannot start: no better-ccflare gateway is configured. Anthropic allows the Agent SDK only with API-key authentication; subscription (OAuth) accounts stay on the claude-code CLI. Set an Anthropic API key for project "My project" (Settings › Project), or use claude-code for this role.',
    });
  });
});
