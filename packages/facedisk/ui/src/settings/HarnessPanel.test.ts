import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { HarnessStatus } from "../api-types.js";
import { NoAgentCard } from "../overview/NoAgentCard.js";
import { HarnessPanel } from "./HarnessPanel.js";

const status: HarnessStatus = {
  anyInstalled: true,
  anyReady: true,
  gateway: { status: "ok", message: "" },
  checks: [],
  checkedAt: "2026-11-12T00:00:00Z",
  tools: {
    "claude-code": {
      displayName: "Claude Code",
      installed: true,
      version: "2.1.0",
      message: "ok",
      ready: true,
      readyReason: "Installed.",
    },
    opencode: {
      displayName: "OpenCode",
      installed: true,
      foundOffPath: "/opt/oc/opencode",
      message: "found off PATH",
      ready: true,
      readyReason: "Installed.",
    },
    codex: {
      displayName: "Codex",
      installed: false,
      message: "not found",
      ready: false,
      readyReason: "Codex is not installed",
    },
  },
};
const html = (el: ReactElement) => renderToStaticMarkup(el);

describe("HarnessPanel", () => {
  it("shows installed, off-PATH and not-found agents", () => {
    const out = html(
      createElement(HarnessPanel, { status, loading: false, failed: false, onRefresh: () => {} }),
    );
    expect(out).toContain("ready");
    expect(out).toContain("found, not on PATH");
    expect(out).toContain("/opt/oc/opencode");
    expect(out).toContain("not found");
    expect(out).toContain("Check again");
    expect(out).not.toContain("No coding agent found");
  });
  it("says so when none is installed", () => {
    const none = { ...status, anyInstalled: false, tools: { codex: status.tools.codex } };
    const out = html(
      createElement(HarnessPanel, {
        status: none,
        loading: false,
        failed: false,
        onRefresh: () => {},
      }),
    );
    expect(out).toContain("No coding agent found");
  });
});

describe("NoAgentCard", () => {
  it("names the install command of each agent", () => {
    const out = html(createElement(NoAgentCard));
    expect(out).toContain("No coding agent found");
    expect(out).toContain("npm install -g @openai/codex");
  });
});
