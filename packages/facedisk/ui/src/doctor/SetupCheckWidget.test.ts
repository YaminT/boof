import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DoctorCheck, HarnessStatus } from "../api-types.js";
import type { HarnessesState } from "../useHarnesses.js";
import { CheckRows } from "./CheckRows.js";
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

const html2 = (h: Partial<HarnessesState>) =>
  renderToStaticMarkup(
    createElement(SetupCheckWidget, {
      harnesses: {
        status: null,
        loading: false,
        failed: false,
        denied: false,
        refresh: () => {},
        ...h,
      },
      pid: "alpha",
    }),
  );

describe("SetupCheckWidget", () => {
  it("ok: calm card, named chips, optional gateway is muted, not an error", () => {
    const out = html(status(true, [check({}), gatewayAbsent]));
    expect(out).toContain('data-state="compact"');
    expect(out).toContain('data-tone="ok"');
    expect(out).toContain("Everything is ready");
    expect(out).toContain(">A<");
    expect(out).toContain(">B<");
    expect(out).toContain("Gateway: not set up (optional)");
    expect(out).toMatch(/data-tone="optional" data-testid="chip-gateway"/);
    expect(out).not.toContain("Fix it");
    expect(out).not.toContain('data-testid="check-git"');
    expect(out).toContain('aria-label="Check again"');
    expect(out).toContain('aria-label="Show details"');
    expect(out).toContain('aria-label="Open full check"');
    expect(out).toContain('href="doctor"');
  });

  it("warn: grows, names the first problem, links the chip and offers a fix", () => {
    const out = html(
      status(true, [
        check({
          id: "sandbox",
          label: "Sandbox",
          status: "warn",
          message: "No.",
          fixPage: "sandbox",
        }),
        gatewayAbsent,
      ]),
    );
    expect(out).toContain('data-state="expanded"');
    expect(out).toContain('data-tone="warn"');
    expect(out).toContain("Needs attention: Sandbox");
    expect(out).toMatch(/<a href="p\/alpha\/settings\/agents"[^>]*data-tone="warn"/);
    expect(out).toContain("Fix it");
    expect(out).toContain('data-testid="check-gateway"');
    expect(out).toMatch(/<a href="p\/alpha\/settings\/accounts"[^>]*>Settings<\/a>/);
  });

  it("fail: cannot run tasks while no agent is ready", () => {
    const out = html(status(false, [check({ id: "agents", status: "fail", fixPage: "agents" })]));
    expect(out).toContain('data-state="expanded"');
    expect(out).toContain('data-tone="fail"');
    expect(out).toContain("Boof can&#x27;t run tasks yet");
    expect(out).toContain('href="p/alpha/settings/agents"');
  });

  it("loading: shows Checking… and no chips", () => {
    const out = html2({ loading: true });
    expect(out).toContain('data-tone="loading"');
    expect(out).toContain("Checking…");
    expect(out).not.toContain("dc-chip");
    expect(out).not.toContain("Show details");
  });

  it("failed and denied answers say so", () => {
    expect(html2({ failed: true })).toContain("Could not run the checks");
    expect(html2({ failed: true, denied: true })).toContain("This key cannot read the Doctor");
  });

  it("details: the optional gateway row is muted, not a warning, and keeps its link", () => {
    const out = renderToStaticMarkup(
      createElement(CheckRows, { status: status(true, [check({}), gatewayAbsent]), pid: "alpha" }),
    );
    expect(out).toContain("optional — not set up");
    expect(out).not.toContain("! warning");
    expect(out).toContain("<a ");
  });
});
