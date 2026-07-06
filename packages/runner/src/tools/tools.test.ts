import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execCommand } from "../exec.js";
import { MockTool, mockState, resetMock } from "./mock.js";
import { parseUsage, sumUsage, UNKNOWN_USAGE } from "./usage.js";
import { ToolRegistry } from "./registry.js";
import { ClaudeCodeTool, StreamRenderer } from "./claude-code.js";
import { CodexTool } from "./codex.js";
import type { Tool } from "./types.js";

afterEach(() => resetMock());

const baseOpts = {
  model: "mock-default",
  systemPrompt: "sys",
  prompt: "do it",
  cwd: "/tmp",
  autoApprove: true,
} as const;

describe("MockTool", () => {
  it("produces deterministic output and report per role", async () => {
    const tool = new MockTool();
    const a = await tool.run({ ...baseOpts, role: "developer" });
    const b = await tool.run({ ...baseOpts, role: "developer" });
    expect(a.report).toBe(b.report);
    expect(a.report).toContain("Developer report");
    expect(a.usage?.known).toBe(true);
  });

  it("emits planner questions once when configured, then proceeds", async () => {
    mockState.plannerQuestions = ["What auth provider?"];
    const tool = new MockTool();
    const first = await tool.run({ ...baseOpts, role: "planner" });
    expect(first.questions).toEqual(["What auth provider?"]);
    const second = await tool.run({ ...baseOpts, role: "planner" });
    expect(second.questions).toBeUndefined();
    expect(second.report).toContain("Plan");
  });

  it("injects a failure for a role", async () => {
    mockState.failRole = "developer";
    const tool = new MockTool();
    await expect(tool.run({ ...baseOpts, role: "developer" })).rejects.toThrow();
  });

  it("is always available via detect", async () => {
    expect((await new MockTool().detect()).status).toBe("available");
  });

  it("lists its default model", async () => {
    expect(await new MockTool().listModels()).toEqual(["mock-default"]);
  });
});

describe("usage parsing", () => {
  it("parses input/output/cost from output", () => {
    const u = parseUsage("input_tokens: 100 output_tokens: 42 cost: $0.01");
    expect(u).toEqual({ inputTokens: 100, outputTokens: 42, costUsd: 0.01, known: true });
  });

  it("returns unknown when no usage present", () => {
    expect(parseUsage("nothing here")).toEqual(UNKNOWN_USAGE);
  });

  it("sums usages", () => {
    const total = sumUsage([
      { inputTokens: 1, outputTokens: 2, costUsd: 0.1, known: true },
      { inputTokens: 3, outputTokens: 4, costUsd: 0.2, known: true },
    ]);
    expect(total.inputTokens).toBe(4);
    expect(total.outputTokens).toBe(6);
    expect(total.costUsd).toBeCloseTo(0.3);
  });
});

describe("exec cancellation", () => {
  it("stops a child process when the stop signal file appears", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boof-runner-stop-"));
    const stopPath = join(dir, "stop");
    try {
      setTimeout(() => void writeFile(stopPath, "stop\n"), 100);
      const res = await execCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: dir,
        timeoutMs: 5000,
        stopSignalPath: stopPath,
        stopPollMs: 25,
      });
      expect(res.stopped).toBe(true);
      expect(res.timedOut).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("StreamRenderer (claude stream-json)", () => {
  const lines = [
    {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " world" },
      },
    },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", name: "Read" },
      },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"file_path":"a.ts"}' },
      },
    },
    { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
    {
      type: "user",
      message: { content: [{ type: "tool_result", content: "line one\nline two" }] },
    },
    {
      type: "result",
      result: "Final plan",
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.02,
    },
  ];

  it("renders live text token-by-token, tool calls, results, report and usage", () => {
    const live: string[] = [];
    const r = new StreamRenderer((t) => live.push(t));
    // Feed as a single blob split mid-line to exercise the line buffer.
    const blob = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    r.push(blob.slice(0, 50));
    r.push(blob.slice(50));
    r.flush();

    expect(live.join("")).toContain("Hello world");
    expect(r.transcript).toContain("⏺ Read(a.ts)");
    expect(r.transcript).toContain("⎿ line one");
    expect(r.transcript).not.toContain("line two"); // only first line of a result
    expect(r.report).toBe("Final plan");
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.02, known: true });
  });
});

describe("health detection", () => {
  it("reports unavailable for a missing CLI", async () => {
    process.env.BOOF_RUNNER_CLAUDE_BIN = "definitely-not-a-real-binary-xyz";
    const res = await new ClaudeCodeTool().detect();
    expect(res.status).toBe("unavailable");
    delete process.env.BOOF_RUNNER_CLAUDE_BIN;
  });

  it("registry runs health for all tools and never throws", async () => {
    process.env.BOOF_RUNNER_CLAUDE_BIN = "definitely-not-real-claude-xyz";
    process.env.BOOF_RUNNER_CODEX_BIN = "definitely-not-real-codex-xyz";
    const reg = new ToolRegistry();
    const health = await reg.healthAll();
    expect(health.mock.status).toBe("available");
    expect(health["claude-code"].status).toBe("unavailable");
    expect(health.codex.status).toBe("unavailable");
    expect(
      reg
        .list()
        .map((t) => t.id)
        .sort(),
    ).toEqual(["claude-code", "codex", "mock"]);
    delete process.env.BOOF_RUNNER_CLAUDE_BIN;
    delete process.env.BOOF_RUNNER_CODEX_BIN;
    void CodexTool;
  });

  it("registry collects model lists and falls back to defaults", async () => {
    const failing = {
      id: "failing",
      displayName: "Failing",
      defaultModels: ["fallback"],
      detect: async () => ({ status: "unavailable", message: "nope" }),
      listModels: async () => {
        throw new Error("no models");
      },
      run: async () => {
        throw new Error("not used");
      },
    } satisfies Tool;
    const reg = new ToolRegistry([new MockTool(), failing]);
    expect(await reg.modelsAll()).toEqual({
      mock: ["mock-default"],
      failing: ["fallback"],
    });
  });
});
