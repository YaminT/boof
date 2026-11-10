import { describe, expect, it } from "vitest";
import {
  CLAUDE_AGENT_DESKTOP_NOTE,
  agentAuthLine,
  agentSdkSummary,
  claudeAgentRefusal,
  claudeAgentRoles,
  effectiveTool,
  isApiKeyShape,
  projectKeyLine,
  stepRole,
  switchModelChoices,
  toolUnavailableProblem,
  toolUnavailableReason,
} from "./claude-agent.js";

const refused = {
  projectId: "alpha",
  roles: ["developer" as const],
  allowed: false,
  via: null,
  reason: "claude-agent cannot start: subscription accounts stay on claude-code.",
};

describe("claude-agent helpers", () => {
  it("accepts only Anthropic API keys, not OAuth or admin tokens", () => {
    expect(isApiKeyShape("sk-ant-api03-" + "x".repeat(40))).toBe(true);
    expect(isApiKeyShape("sk-ant-oat01-" + "x".repeat(40))).toBe(false);
    expect(isApiKeyShape("sk-ant-admin01-" + "x".repeat(40))).toBe(false);
    expect(isApiKeyShape("")).toBe(false);
  });

  it("makes claude-agent unavailable on the desktop app, with the fixed note and problem", () => {
    expect(toolUnavailableReason("claude-agent", { isDesktop: true })).toBe(
      CLAUDE_AGENT_DESKTOP_NOTE,
    );
    expect(toolUnavailableProblem("claude-agent", { isDesktop: true })).toBe(
      "claude-agent is not available in the desktop app.",
    );
    expect(toolUnavailableReason("claude-code", { isDesktop: true })).toBeNull();
    expect(toolUnavailableReason("claude-agent", {})).toBeNull();
  });

  it("uses the API's unavailableReason for any tool that carries one", () => {
    const env = { unavailable: { "claude-agent": "the SDK is not installed" } };
    expect(toolUnavailableReason("claude-agent", env)).toBe("the SDK is not installed");
    expect(toolUnavailableProblem("claude-agent", env)).toBe(
      "claude-agent is not available: the SDK is not installed",
    );
  });

  it("words the live line from runner.status.agentAuth", () => {
    expect(agentAuthLine(undefined)).toBeNull();
    expect(agentAuthLine({ ...refused, allowed: true, via: "gateway", reason: null })).toBe(
      "Ready: via better-ccflare",
    );
    expect(agentAuthLine({ ...refused, allowed: true, via: "project-key", reason: null })).toBe(
      "Ready: via the project's API key",
    );
    expect(agentAuthLine(refused)).toBe(refused.reason);
  });

  it("summarizes the gateway eligibility with its reason", () => {
    expect(agentSdkSummary(null)).toBeNull();
    expect(
      agentSdkSummary({
        gateway: "checked",
        allowed: true,
        reason: "every better-ccflare account uses API-key authentication",
        blocking: [],
      }),
    ).toBe(
      "Claude Agent SDK through this gateway: allowed. Every better-ccflare account uses API-key authentication.",
    );
  });

  it("finds the roles a draft gives to claude-agent, project overrides first", () => {
    const agent = { tool: "claude-agent", model: "default" };
    const code = { tool: "claude-code", model: "opus" };
    expect(
      claudeAgentRoles({ developer: code, reviewer: agent }, { developer: agent, reviewer: code }),
    ).toEqual(["developer"]);
  });

  it("works out the tool of the running step and the models it can switch to", () => {
    expect(stepRole("Developer (steer 1)")).toBe("developer");
    expect(stepRole("Closing")).toBeNull();
    const settings = { roles: { developer: { tool: "claude-code", model: "opus" } } };
    const project = { roles: { developer: { tool: "claude-agent", model: "default" } } };
    expect(effectiveTool("developer", undefined, project, settings)).toBe("claude-agent");
    expect(
      effectiveTool("developer", { developer: { tool: "codex", model: "" } }, project, settings),
    ).toBe("codex");
    expect(effectiveTool("developer", undefined, null, settings)).toBe("claude-code");
    const models = { "claude-agent": ["default", "opus"], codex: ["gpt"], "claude-code": ["opus"] };
    expect(switchModelChoices("claude-agent", models)).toEqual(["default", "opus"]);
    expect(switchModelChoices("claude-code", models)).toEqual(["opus"]);
    expect(switchModelChoices("codex", models)).toEqual([]);
    expect(switchModelChoices(null, models)).toEqual([]);
  });

  it("shows the refusal in the Now lane only for a refused project with a claude-agent task waiting", () => {
    const queued = [{ frontmatter: {} }];
    expect(claudeAgentRefusal(refused, queued)).toBe(refused.reason);
    expect(claudeAgentRefusal(refused, [])).toBeNull();
    expect(claudeAgentRefusal({ ...refused, allowed: true, reason: null }, queued)).toBeNull();
    expect(claudeAgentRefusal(undefined, queued)).toBeNull();
    // A task that gives the refused role to another tool is not affected.
    expect(
      claudeAgentRefusal(refused, [
        { frontmatter: { tools: { developer: { tool: "codex", model: "" } } } },
      ]),
    ).toBeNull();
  });
});

describe("projectKeyLine", () => {
  const closed = { gateway: "checked" as const, allowed: false, reason: "x", blocking: [] };
  const open = { ...closed, allowed: true };
  it("uses the project key when the gateway is refused and a key is set", () => {
    expect(projectKeyLine("gateway", true, closed)).toBe(
      "claude-agent will use this project's Anthropic API key.",
    );
    expect(projectKeyLine("gateway", true, open)).toBeNull();
    expect(projectKeyLine("gateway", false, closed)).toBeNull();
    expect(projectKeyLine("gateway", true, null)).toBeNull();
  });
  it("always uses the key in project-key mode", () => {
    expect(projectKeyLine("project-key", true, open)).toBe(
      "claude-agent always uses this project's Anthropic API key.",
    );
    expect(projectKeyLine("project-key", false, open)).toContain("needs this project's");
  });
});
