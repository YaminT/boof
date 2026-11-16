import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DoctorCheck, HarnessStatus } from "../api-types.js";
import type { HarnessesState } from "../useHarnesses.js";
import { SetupCheckWidget } from "./SetupCheckWidget.js";

const check = (over: Partial<DoctorCheck>): DoctorCheck => ({
  id: "git",
  label: "git",
  status: "pass",
  message: "git version 2",
  ...over,
});
const gatewayAbsent = check({
  id: "gateway",
  label: "better-ccflare gateway",
  status: "warn",
  message: "Not configured.",
  fixHint: "Configure the better-ccflare gateway in Settings.",
  fixPage: "gateway",
});
const status = (anyReady: boolean, checks: DoctorCheck[]): HarnessStatus => ({
  tools: {
    a: { displayName: "A", installed: true, message: "", ready: anyReady, readyReason: "" },
    b: { displayName: "B", installed: true, message: "", ready: anyReady, readyReason: "" },
  },
  anyInstalled: true,
  anyReady,
  gateway: { status: "absent", message: "" },
  checks,
  checkedAt: "",
});
const html = (s: HarnessStatus | null) => {
  const h: HarnessesState = {
    status: s,
    loading: false,
    failed: false,
    denied: false,
    refresh: () => {},
  };
  return renderToStaticMarkup(createElement(SetupCheckWidget, { harnesses: h, pid: "alpha" }));
};

describe("SetupCheckWidget", () => {
  it("is one compact line when everything works, gateway optional", () => {
    const out = html(status(true, [check({}), gatewayAbsent]));
    expect(out).toContain('data-state="compact"');
    expect(out).toContain("Doctor: OK · 2 agents ready · gateway not configured (optional)");
    expect(out).not.toContain('data-testid="check-git"');
    expect(out).toContain("Show details");
    expect(out).toContain("Check again");
    expect(out).toContain('href="doctor"');
  });

  it("opens by itself on a warning and links the gateway row to the accounts settings", () => {
    const out = html(
      status(true, [check({ id: "sandbox", status: "warn", message: "No." }), gatewayAbsent]),
    );
    expect(out).toContain('data-state="expanded"');
    expect(out).toContain('data-testid="check-gateway"');
    expect(out).toMatch(/<a href="p\/alpha\/settings\/accounts"[^>]*>Settings<\/a>/);
  });

  it("opens on a failure and is shown while no agent is ready", () => {
    const out = html(status(false, [check({ id: "agents", status: "fail", fixPage: "agents" })]));
    expect(out).toContain('data-state="expanded"');
    expect(out).toContain('href="p/alpha/settings/agents"');
  });

  it("still renders while the first answer is pending", () => {
    expect(html(null)).toContain("Doctor");
  });
});
