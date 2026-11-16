import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DoctorCheck, HarnessStatus } from "../api-types.js";
import type { HarnessesState } from "../useHarnesses.js";
import { DoctorPage } from "./DoctorPage.js";

const check = (over: Partial<DoctorCheck>): DoctorCheck => ({
  id: "git",
  label: "git",
  status: "pass",
  message: "git version 2",
  ...over,
});
const status = (anyReady: boolean, checks: DoctorCheck[]): HarnessStatus => ({
  tools: {
    "claude-agent": {
      displayName: "Claude Agent SDK",
      installed: true,
      message: "ok",
      ready: anyReady,
      readyReason: anyReady ? "Uses the better-ccflare gateway." : "No gateway configured.",
      ...(anyReady ? {} : { fixHint: "Configure the better-ccflare gateway in Settings." }),
    },
  },
  anyInstalled: true,
  anyReady,
  gateway: { status: anyReady ? "ok" : "absent", message: "" },
  checks,
  checkedAt: "",
});
const state = (over: Partial<HarnessesState>): HarnessesState => ({
  status: null,
  loading: false,
  failed: false,
  denied: false,
  refresh: () => {},
  ...over,
});
const html = (h: HarnessesState, pid: string | null = "alpha") =>
  renderToStaticMarkup(createElement(DoctorPage, { harnesses: h, pid, onContinue: () => {} }));

describe("DoctorPage", () => {
  it("says All set and offers Back to boof when an agent is ready and every check passes", () => {
    const out = html(state({ status: status(true, [check({})]) }));
    expect(out).toContain("All set");
    expect(out).toContain('data-testid="doctor-all-set"');
    expect(out).toContain(">Back to boof</button>");
    expect(out).not.toContain("Continue");
    expect(out).toContain("Check again");
  });

  it("never blocks on a warning when an agent is ready", () => {
    const out = html(
      state({ status: status(true, [check({ id: "sandbox", status: "warn", message: "Off." })]) }),
    );
    expect(out).toContain("All set: an agent is ready");
    expect(out).toContain("! warning");
  });

  it("blocks with the reason and a Settings fix link when no agent is ready", () => {
    const out = html(
      state({
        status: status(false, [
          check({
            id: "gateway",
            label: "better-ccflare gateway",
            status: "fail",
            message: "Not configured.",
            fixHint: "Configure the better-ccflare gateway in Settings.",
            fixPage: "gateway",
          }),
        ]),
      }),
    );
    expect(out).toContain('data-testid="doctor-blocked"');
    expect(out).toContain("Not configured.");
    expect(out).toContain("Configure the better-ccflare gateway in ");
    expect(out).toMatch(/<a href="p\/alpha\/settings\/accounts"[^>]*>Settings<\/a>/);
    expect(out).not.toContain("Open Settings");
    expect(out).not.toContain("Back to boof");
    expect(out).toContain("Cannot run tasks yet: no coding agent is ready");
    expect(out).toContain("installed, not ready");
  });

  it("blocks when the server reports git as a hard failure even with an agent ready", () => {
    const out = html(
      state({ status: status(true, [check({ id: "git", status: "fail", message: "no git" })]) }),
    );
    expect(out).toContain('data-testid="doctor-blocked"');
    expect(out).not.toContain("Back to boof");
  });

  it("links to Settings with a placeholder project before the first project exists", () => {
    const out = html(
      state({
        status: status(false, [check({ id: "agents", status: "fail", fixPage: "agents" })]),
      }),
      null,
    );
    expect(out).toContain('href="p/setup/settings/agents"');
  });

  it("tells a key without settings:read to ask the owner", () => {
    const out = html(state({ denied: true, failed: true }));
    expect(out).toContain("ask the owner".replace("ask", "Ask"));
    expect(out).toContain('data-testid="doctor-denied"');
  });

  it("shows progress while the first check runs", () => {
    expect(html(state({ loading: true }))).toContain("Checking this computer");
  });
});
