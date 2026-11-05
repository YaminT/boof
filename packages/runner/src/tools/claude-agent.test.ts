import { describe, expect, it, vi } from "vitest";
import { ClaudeAgentTool, usageFromSdkResult } from "./claude-agent.js";
import { fakeSdk } from "./fake-agent-sdk.js";
import { AgentAuthRefusedError } from "../agent-auth.js";
import { DESKTOP_CLAUDE_AGENT_REASON } from "../index.js";
import { ToolRunError, isTransientToolError } from "./errors.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = {
  role: "developer" as const,
  model: "default",
  systemPrompt: "system",
  prompt: "hello",
  cwd: "/tmp",
  claudeConfigDir: "/tmp/boof-data/claude-agent-config/project",
  autoApprove: false,
  agentAuth: { kind: "gateway" as const, url: "http://127.0.0.1:0", apiKey: "fake-gateway-key" },
};
const msg = (type: string, data: Record<string, unknown> = {}) => ({ type, ...data });

describe("ClaudeAgentTool", () => {
  it("maps model, permission, resume, MCP and system prompt options", async () => {
    const fake = fakeSdk([{ emit: msg("result", { subtype: "success", result: "ok" }) }]);
    const tool = new ClaudeAgentTool({
      loadSdk: async () => fake.sdk,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
    });
    await tool.run({
      ...base,
      model: "default",
      autoApprove: true,
      inheritMcpServers: false,
      resumeSessionId: "s1",
    });
    expect(fake.calls.options[0]).toMatchObject({
      cwd: "/tmp",
      resume: "s1",
      strictMcpConfig: true,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      extraArgs: { bare: null },
      systemPrompt: { type: "preset", preset: "claude_code", append: "system" },
    });
    expect(fake.calls.options[0].env).toMatchObject({
      CLAUDE_CONFIG_DIR: "/tmp/boof-data/claude-agent-config/project",
      ANTHROPIC_API_KEY: "fake-gateway-key",
    });
    expect(fake.calls.options[0].env.CLAUDE_CONFIG_DIR).not.toBe("/tmp");
    expect(fake.calls.options[0].env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(fake.calls.options[0]).not.toHaveProperty("model");
  });

  it.each([
    ["gateway", { kind: "gateway" as const, url: "http://127.0.0.1:0", apiKey: "gateway" }],
    ["project-key", { kind: "project-key" as const, apiKey: "sk-ant-api03-abcdefghijklmnop" }],
  ])("uses bare mode, no settings, and API key auth in %s mode", async (_mode, agentAuth) => {
    const fake = fakeSdk([{ emit: msg("result", { subtype: "success", result: "ok" }) }]);
    const tool = new ClaudeAgentTool({
      loadSdk: async () => fake.sdk,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
    });
    await tool.run({ ...base, agentAuth });
    expect(fake.calls.options[0]).toMatchObject({ settingSources: [], extraArgs: { bare: null } });
    expect(fake.calls.options[0].env).toHaveProperty("ANTHROPIC_API_KEY");
    expect(fake.calls.options[0].env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });

  it("refuses to use cwd as a fallback config directory", async () => {
    const loadSdk = vi.fn();
    const tool = new ClaudeAgentTool({ loadSdk });
    const { claudeConfigDir: _unused, ...withoutConfigDir } = base;
    await expect(tool.run(withoutConfigDir)).rejects.toThrow(/per-project Claude config directory/);
    expect(loadSdk).not.toHaveBeenCalled();
  });

  it("streams output and reports SDK usage; omits default model", async () => {
    const fake = fakeSdk([
      {
        emit: msg("system", {
          subtype: "init",
          session_id: "sess",
          apiKeySource: "ANTHROPIC_API_KEY",
        }),
      },
      {
        emit: msg("stream_event", {
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
        }),
      },
      {
        emit: msg("result", {
          subtype: "success",
          result: "report",
          total_cost_usd: 0.42,
          modelUsage: {
            a: {
              inputTokens: 2,
              cacheReadInputTokens: 3,
              cacheCreationInputTokens: 4,
              outputTokens: 5,
              costBasis: "list",
            },
            b: { inputTokens: 1, outputTokens: 2 },
          },
        }),
      },
    ]);
    const onChunk = vi.fn();
    const tool = new ClaudeAgentTool({
      loadSdk: async () => fake.sdk,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
    });
    const result = await tool.run({ ...base, onChunk });
    expect(fake.calls.options[0]).not.toHaveProperty("model");
    expect(result).toMatchObject({
      report: "report",
      sessionId: "sess",
      usage: { inputTokens: 10, outputTokens: 7, costUsd: 0.42, known: true },
    });
    expect(onChunk.mock.calls.flat().join("")).toContain("hello");
  });

  it("appends the working directory CLAUDE.md to the system prompt in bare mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "claude-agent-bare-"));
    try {
      await writeFile(join(cwd, "CLAUDE.md"), "repo-specific instructions");
      const fake = fakeSdk([{ emit: msg("result", { subtype: "success", result: "ok" }) }]);
      const tool = new ClaudeAgentTool({
        loadSdk: async () => fake.sdk,
        resolveExecutable: async () => ({ path: "/fake", source: "env" }),
      });
      await tool.run({ ...base, cwd });
      expect(fake.calls.options[0].systemPrompt).toMatchObject({
        append: expect.stringContaining(
          "## Repository instructions (CLAUDE.md)\nrepo-specific instructions",
        ),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not pass a literal default model, but passes explicit models", async () => {
    expect(
      usageFromSdkResult(
        { total_cost_usd: 1, modelUsage: {} },
        { inputTokens: 0, outputTokens: 0, costUsd: 0.4, known: true },
      ).costUsd,
    ).toBeCloseTo(0.6);
    const f = fakeSdk([{ emit: msg("result", { subtype: "success", result: "ok" }) }]);
    const t = new ClaudeAgentTool({
      loadSdk: async () => f.sdk,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
    });
    await t.run({ ...base, model: "opus" });
    expect(f.calls.options[0].model).toBe("opus");
  });

  it("fails closed on unavailable mode without loading the SDK", async () => {
    const loadSdk = vi.fn();
    const resolveExecutable = vi.fn();
    const tool = new ClaudeAgentTool({
      unavailableReason: DESKTOP_CLAUDE_AGENT_REASON,
      loadSdk,
      resolveExecutable,
    });
    expect(await tool.detect()).toEqual({
      status: "unavailable",
      message: DESKTOP_CLAUDE_AGENT_REASON,
    });
    await expect(tool.run({ ...base })).rejects.toBeInstanceOf(AgentAuthRefusedError);
    expect(loadSdk).not.toHaveBeenCalled();
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it("retains transient error detection for SDK error results", async () => {
    const fake = fakeSdk([
      {
        emit: msg("result", {
          subtype: "error_api",
          is_error: true,
          errors: ["API Error: 529 overloaded"],
        }),
      },
    ]);
    const tool = new ClaudeAgentTool({
      loadSdk: async () => fake.sdk,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
    });
    try {
      await tool.run({ ...base });
    } catch (e) {
      expect(e).toBeInstanceOf(ToolRunError);
      expect(isTransientToolError(e)).toBe(true);
    }
  });

  it("rejects project-key sessions that use OAuth or no credential", async () => {
    const fake = fakeSdk([{ emit: msg("system", { subtype: "init", apiKeySource: "none" }) }]);
    const tool = new ClaudeAgentTool({
      loadSdk: async () => fake.sdk,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
    });
    await expect(
      tool.run({
        ...base,
        agentAuth: { kind: "project-key", apiKey: "sk-ant-api03-abcdefghijklmnop" },
      }),
    ).rejects.toMatchObject({
      output: expect.stringContaining("explicit ANTHROPIC_API_KEY"),
    });
    expect(fake.calls.closed).toBe(1);
  });

  it("redacts project keys from streamed output and stderr", async () => {
    const key = "sk-ant-api03-abcdefghijklmnop";
    const fake = fakeSdk([
      { emit: msg("system", { subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" }) },
      {
        emit: msg("stream_event", {
          event: { type: "content_block_delta", delta: { type: "text_delta", text: key } },
        }),
      },
      {
        emit: msg("result", {
          subtype: "success",
          result: key,
          total_cost_usd: 0.1,
          modelUsage: {},
        }),
      },
    ]);
    const streamed: string[] = [];
    const tool = new ClaudeAgentTool({
      loadSdk: async () => fake.sdk,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
    });
    const result = await tool.run({
      ...base,
      agentAuth: { kind: "project-key", apiKey: key },
      onChunk: (s) => streamed.push(s),
    });
    expect(streamed.join("")).not.toContain(key);
    expect(result.output).not.toContain(key);
    expect(result.report).not.toContain(key);
    expect(fake.calls.options[0].env.ANTHROPIC_API_KEY).toBe(key);
    expect(fake.calls.options[0].env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });
});
