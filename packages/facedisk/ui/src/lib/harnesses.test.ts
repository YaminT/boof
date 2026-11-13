import { describe, expect, it } from "vitest";
import type { HarnessStatus } from "../api-types.js";
import {
  harnessRows,
  harnessToolLabel,
  installHelp,
  noAgentFound,
  notInstalledWarnings,
  toolChoices,
} from "./harnesses.js";

const info = (over: Partial<HarnessStatus["tools"][string]> = {}) => ({
  displayName: "X",
  installed: false,
  message: "not found",
  readyReason: "",
  ready: over.installed ?? false,
  ...over,
});
const status = (tools: HarnessStatus["tools"]): HarnessStatus => ({
  tools,
  anyInstalled: Object.values(tools).some((t) => t.installed),
  anyReady: Object.values(tools).some((t) => t.ready),
  gateway: { status: "ok", message: "" },
  checks: [],
  checkedAt: "2026-11-12T00:00:00Z",
});
const s = status({
  "claude-code": info({ displayName: "Claude Code", installed: true, version: "2.1.0" }),
  codex: info({ displayName: "Codex" }),
  opencode: info({ displayName: "OpenCode", installed: true, foundOffPath: "/opt/oc" }),
  "claude-agent": info({ displayName: "Claude Agent SDK", installed: true }),
});
const all = ["claude-code", "codex", "opencode", "claude-agent"];

describe("toolChoices", () => {
  it("lists installed tools only", () => {
    expect(toolChoices(all, s, {})).toEqual(["claude-code", "opencode", "claude-agent"]);
  });
  it("keeps a saved tool that is not installed", () => {
    expect(toolChoices(all, s, {}, "codex")).toEqual([
      "claude-code",
      "opencode",
      "claude-agent",
      "codex",
    ]);
    expect(harnessToolLabel("codex", s)).toBe("codex (not installed)");
    expect(harnessToolLabel("claude-code", s)).toBe("claude-code");
  });
  it("does not list claude-agent on desktop", () => {
    expect(toolChoices(all, s, { isDesktop: true })).toEqual(["claude-code", "opencode"]);
  });
  it("offers everything while the check has not answered", () => {
    expect(toolChoices(all, null, {})).toEqual(all);
    expect(harnessToolLabel("codex", null)).toBe("codex");
  });
});

describe("notInstalledWarnings", () => {
  it("warns per role, the project's own choice over the shared one", () => {
    const w = notInstalledWarnings(
      { planner: { tool: "codex" }, developer: { tool: "claude-code" } },
      { developer: { tool: "codex" } },
      s,
    );
    expect(w).toHaveLength(2);
    expect(w[0]).toContain("Planner uses codex");
    expect(w[1]).toContain("Developer uses codex");
    expect(notInstalledWarnings({ planner: { tool: "codex" } }, {}, null)).toEqual([]);
  });
});

describe("harnessRows and the none-installed state", () => {
  it("orders installed, off PATH, then not found", () => {
    expect(harnessRows(s).map((r) => [r.id, r.state])).toEqual([
      ["claude-agent", "installed"],
      ["claude-code", "installed"],
      ["opencode", "off-path"],
      ["codex", "not-found"],
    ]);
    expect(harnessRows(s, { isDesktop: true }).some((r) => r.id === "claude-agent")).toBe(false);
  });
  it("noAgentFound is true only when the check ran and found none", () => {
    expect(noAgentFound(null)).toBe(false);
    expect(noAgentFound(s)).toBe(false);
    expect(noAgentFound(status({ codex: info() }))).toBe(true);
  });
  it("has install help for each known agent", () => {
    expect(installHelp().map((h) => h.id)).toEqual(["claude-code", "codex", "opencode"]);
  });
});
