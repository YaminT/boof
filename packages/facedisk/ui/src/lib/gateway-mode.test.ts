import { describe, expect, it } from "vitest";
import { addAccountProblem, modeSettings, poolModeOf, TERMS_NOTE } from "./gateway-mode.js";

const KEY = "sk-ant-api03-abcdefghijklmnop";

describe("poolModeOf", () => {
  it("resolves like the server: gateway.mode, else owlish, else none", () => {
    expect(poolModeOf({})).toBe("none");
    expect(poolModeOf({ owlish: { url: "http://127.0.0.1:8080", healthGate: "pause" } })).toBe(
      "better-ccflare",
    );
    expect(poolModeOf({ gateway: { mode: "internal" } })).toBe("internal");
    expect(
      poolModeOf({
        gateway: { mode: "none" },
        owlish: { url: "http://127.0.0.1:8080", healthGate: "pause" },
      }),
    ).toBe("none");
  });
});

describe("modeSettings", () => {
  it("keeps strategy and health gate across a mode switch", () => {
    expect(
      modeSettings(
        { gateway: { mode: "internal", strategy: "round-robin", healthGate: "warn" } },
        "none",
      ),
    ).toEqual({ mode: "none", strategy: "round-robin", healthGate: "warn" });
    expect(modeSettings({}, "internal")).toEqual({ mode: "internal" });
  });
});

describe("addAccountProblem", () => {
  it("accepts a named Console key with an optional priority", () => {
    expect(addAccountProblem("work", KEY, "")).toBeNull();
    expect(addAccountProblem("work", KEY, "5")).toBeNull();
  });
  it("rejects missing names, subscription-style tokens and bad priorities", () => {
    expect(addAccountProblem(" ", KEY, "")).toMatch(/name/);
    expect(addAccountProblem("a", "sk-ant-oat01-abcdefghijklmnopqrstuv", "")).toMatch(/API key/);
    expect(addAccountProblem("a", "sk-ant-api", "")).toMatch(/API key/);
    expect(addAccountProblem("a", KEY, "101")).toMatch(/priority/);
    expect(addAccountProblem("a", KEY, "1.5")).toMatch(/priority/);
  });
  it("never repeats the key in its message", () => {
    expect(addAccountProblem("a", "sk-ant-oat-SECRETSECRETSECRET", "")).not.toContain("SECRET");
  });
});

describe("terms note", () => {
  it("states the API-key-only rule", () => {
    expect(TERMS_NOTE).toContain("Anthropic API keys only");
    expect(TERMS_NOTE).toContain("subscription sign-ins");
  });
});
