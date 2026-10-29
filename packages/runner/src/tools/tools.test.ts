import { fileURLToPath } from "node:url";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseVerdict } from "@boof-runner/shared";
import { execCommand } from "../exec.js";
import { MockTool, mockState, resetMock } from "./mock.js";
import { parseUsage, sumUsage, UNKNOWN_USAGE } from "./usage.js";
import { ToolRegistry } from "./registry.js";
import { ClaudeCodeTool, StreamRenderer } from "./claude-code.js";
import { isTransientToolError, ToolRunError } from "./errors.js";
import { CodexTool } from "./codex.js";
import { OpencodeTool } from "./opencode.js";
import { formatQuestions, parseQuestions } from "./questions.js";
import type { Tool } from "./types.js";

afterEach(() => resetMock());

const fixture = (name: string) => fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));

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

  it("ignores a truncated marker line and uses the last complete one", async () => {
    const tool = new MockTool();
    const prompt =
      "title [[mock-verdicts reviewer=CHANGES_RE\n[[mock-verdicts reviewer=REJECT]]\nbody";
    const res = await tool.run({ ...baseOpts, role: "reviewer", prompt });
    expect(res.report.endsWith("VERDICT: REJECT")).toBe(true);
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

  it("knows the cost only when a price was printed", () => {
    expect(parseUsage("input_tokens: 7 output_tokens: 3")).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      costUsd: 0,
      known: false,
    });
    expect(parseUsage("tokens used\n11,536")).toMatchObject({ inputTokens: 11536, known: false });
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

describe("claude usage (stream-json)", () => {
  const feed = (lines: unknown[]) => {
    const r = new StreamRenderer(() => {});
    r.push(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return r.usage;
  };

  it("counts cache creation and read tokens as input from the result event", () => {
    const u = feed([
      {
        type: "result",
        total_cost_usd: 0.0129,
        usage: {
          input_tokens: 16,
          cache_creation_input_tokens: 5200,
          cache_read_input_tokens: 12000,
          output_tokens: 3496,
        },
      },
    ]);
    expect(u).toEqual({
      inputTokens: 17216,
      outputTokens: 3496,
      costUsd: 0.0129,
      known: true,
    });
  });

  it("falls back to per-message usage without double counting repeated ids", () => {
    const msg = (id: string, i: number, c: number, r: number, o: number) => ({
      type: "assistant",
      message: {
        id,
        usage: {
          input_tokens: i,
          cache_creation_input_tokens: c,
          cache_read_input_tokens: r,
          output_tokens: o,
        },
      },
    });
    const u = feed([msg("m1", 3, 100, 0, 1), msg("m1", 3, 100, 0, 20), msg("m2", 2, 0, 100, 30)]);
    expect(u?.inputTokens).toBe(3 + 100 + 2 + 100);
    expect(u?.outputTokens).toBe(50);
    expect(u?.known).toBe(false);
  });

  it("prefers the result event over earlier per-message usage", () => {
    const u = feed([
      { type: "assistant", message: { id: "m1", usage: { input_tokens: 1, output_tokens: 1 } } },
      {
        type: "result",
        total_cost_usd: 1,
        usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
      },
    ]);
    expect(u?.inputTokens).toBe(100);
    expect(u?.costUsd).toBe(1);
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
    process.env.BOOF_RUNNER_OPENCODE_BIN = "definitely-not-real-opencode-xyz";
    const reg = new ToolRegistry();
    const health = await reg.healthAll();
    expect(health.mock.status).toBe("available");
    expect(health["claude-code"].status).toBe("unavailable");
    expect(health.codex.status).toBe("unavailable");
    expect(health.opencode.status).toBe("unavailable");
    expect(
      reg
        .list()
        .map((t) => t.id)
        .sort(),
    ).toEqual(["claude-code", "codex", "mock", "opencode"]);
    delete process.env.BOOF_RUNNER_CLAUDE_BIN;
    delete process.env.BOOF_RUNNER_CODEX_BIN;
    delete process.env.BOOF_RUNNER_OPENCODE_BIN;
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

describe("CodexTool report", () => {
  let dir: string;
  let prevBin: string | undefined;

  const setup = async (script: string) => {
    prevBin = process.env.BOOF_RUNNER_CODEX_BIN;
    dir = await mkdtemp(join(tmpdir(), "boof-codex-test-"));
    const bin = join(dir, "codex");
    await writeFile(bin, `#!/bin/sh\n${script}\n`);
    await chmod(bin, 0o755);
    process.env.BOOF_RUNNER_CODEX_BIN = bin;
    return new CodexTool();
  };
  afterEach(async () => {
    if (prevBin === undefined) delete process.env.BOOF_RUNNER_CODEX_BIN;
    else process.env.BOOF_RUNNER_CODEX_BIN = prevBin;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("parses a questions block out of the last message", async () => {
    const tool = await setup(
      [
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "-o" ]; then printf "Need input.\\n\\n\\`\\`\\`questions\\n1. Which DB?\\n2. Which region?\\n\\`\\`\\`\\n" > "$2"; fi',
        "  shift",
        "done",
      ].join("\n"),
    );
    const res = await tool.run({ ...baseOpts, role: "planner", cwd: dir });
    expect(res.questions).toEqual(["Which DB?", "Which region?"]);
    expect(res.report).toBe("Need input.");
  });

  it("feeds the prompt through stdin, so a 300 kB prompt arrives whole", async () => {
    const tool = await setup(
      `cat > "$(dirname "$0")/stdin"\nprintf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'`,
    );
    const prompt = "x".repeat(300_000);
    expect(tool.buildArgs({ ...baseOpts, prompt }, "/tmp/last").at(-1)).toBe("-");
    expect(
      tool.buildArgs({ ...baseOpts, prompt }, "/tmp/last").some((a) => a.includes("xxxx")),
    ).toBe(false);
    const res = await tool.run({ ...baseOpts, role: "developer", cwd: dir, prompt });
    expect(res.report).toBe("ok");
    expect(await readFile(join(dir, "stdin"), "utf8")).toBe(`sys\n\n${prompt}`);
    expect(tool.promptText({ ...baseOpts, prompt: "NEW", resumeSessionId: "t" })).toBe("NEW");
  });

  it("uses the --output-last-message file, not noisy stdout", async () => {
    const record = '$(dirname "$0")/out-path';
    const tool = await setup(
      [
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "-o" ]; then',
        `    printf '%s' "$2" > ${record}`,
        '    printf "review\\nVERDICT: APPROVE" > "$2"',
        "  fi",
        "  shift",
        "done",
        'printf "noise\\nVERDICT: APPROVE\\ntokens used: 123\\n"',
      ].join("\n"),
    );
    const res = await tool.run({ ...baseOpts, role: "reviewer", cwd: dir });
    expect(res.report).toBe("review\nVERDICT: APPROVE");
    expect(parseVerdict(res.report)).toBe("APPROVE");
    expect(res.report).not.toContain("tokens used");
    const outPath = await readFile(join(dir, "out-path"), "utf8");
    await expect(access(outPath)).rejects.toThrow();
  });

  it("health probe runs outside a git repo with --skip-git-repo-check", async () => {
    // Fake codex: --version and --help succeed; exec fails like the real CLI
    // ("Not inside a trusted directory") unless --skip-git-repo-check is passed.
    const tool = await setup(
      [
        'case "$1" in --version) echo "codex-cli 0.0.0"; exit 0;; --help) exit 0;; esac',
        'for a in "$@"; do [ "$a" = "--skip-git-repo-check" ] && { echo hi; exit 0; }; done',
        'echo "Not inside a trusted directory" >&2; exit 1',
      ].join("\n"),
    );
    const health = await tool.detect();
    expect(health.status).toBe("available");
  });

  it("parses --json events: report, usage, readable stream", async () => {
    const tool = await setup(`cat "${fixture("codex-json-stdout.jsonl")}"`);
    const chunks: string[] = [];
    const res = await tool.run({
      ...baseOpts,
      role: "reviewer",
      cwd: dir,
      onChunk: (c) => chunks.push(c),
    });
    expect(res.output).toContain("--json");
    expect(res.report).toBe("hi");
    expect(res.usage).toEqual({ inputTokens: 11531, outputTokens: 5, costUsd: 0, known: false });
    const live = chunks.join("");
    expect(live).toContain("hi");
    expect(live).toContain("[warning]");
    expect(live).not.toContain('"type"');
  });

  it("parses the plain-mode `tokens used` total from stderr", async () => {
    const tool = await setup(`cat "${fixture("codex-plain-stderr.txt")}" >&2`);
    const res = await tool.run({ ...baseOpts, role: "reviewer", cwd: dir });
    expect(res.usage).toEqual({ inputTokens: 11536, outputTokens: 0, costUsd: 0, known: false });
  });

  it("renders command and file events compactly", async () => {
    const tool = await setup(
      `printf '%s\\n' '{"type":"item.completed","item":{"type":"command_execution","command":"ls","exit_code":0}}' '{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"a.ts","kind":"update"}]}}' '{"type":"item.completed","item":{"type":"weird"}}' 'plain line'`,
    );
    const chunks: string[] = [];
    await tool.run({ ...baseOpts, role: "developer", cwd: dir, onChunk: (c) => chunks.push(c) });
    expect(chunks.join("")).toBe("$ ls (exit 0)\n[files] update a.ts\n[weird]\nplain line\n");
  });

  it("falls back to stdout when the last-message file is missing", async () => {
    const tool = await setup('printf "x\\nVERDICT: REJECT\\n"');
    const res = await tool.run({ ...baseOpts, role: "reviewer", cwd: dir });
    expect(res.report).toBe("x\nVERDICT: REJECT");
    expect(parseVerdict(res.report)).toBe("REJECT");
  });
});

describe("isTransientToolError", () => {
  const err = (
    output: string,
    stderr = "",
    over: Partial<{ stopped: boolean; timedOut: boolean }> = {},
  ) =>
    new ToolRunError(
      "claude-code",
      1,
      over.timedOut ?? false,
      over.stopped ?? false,
      output,
      stderr,
    );

  it.each([
    ["API Error: 500 Internal Server Error"],
    ["API Error: 503 Service Unavailable"],
    ["API Error: 529 overloaded_error"],
    ["API Error: 429 rate limited"],
    ["HTTP 429 Too Many Requests"],
    ["status 529"],
    ["The API is Overloaded, try again"],
    ["service temporarily unavailable"],
    ["read ECONNRESET"],
    ["connect ETIMEDOUT 1.2.3.4:443"],
    ["request failed: socket hang up"],
  ])("matches %s (in output)", (text) => {
    expect(isTransientToolError(err(`[exit 1]\n${text}`))).toBe(true);
  });

  it("matches stderr too", () => {
    expect(isTransientToolError(err("[exit 1]", "API Error: 502 Bad Gateway"))).toBe(true);
  });

  it("matches a stalled stream", () => {
    const e = new ToolRunError("claude-code", null, false, false, "", "", true, 1200000);
    expect(isTransientToolError(e)).toBe(true);
    expect(e.message).toBe("claude-code stalled: no output for 20 min");
  });

  it("does not match stopped, timed out, plain errors or unrelated failures", () => {
    expect(isTransientToolError(err("API Error: 503", "", { stopped: true }))).toBe(false);
    expect(isTransientToolError(err("API Error: 503", "", { timedOut: true }))).toBe(false);
    expect(isTransientToolError(new Error("API Error: 503"))).toBe(false);
    expect(isTransientToolError("API Error: 503")).toBe(false);
    expect(isTransientToolError(err("[exit 1]\ntests failed: 3 assertions", "boom"))).toBe(false);
    expect(isTransientToolError(err("API Error: 400 Bad Request"))).toBe(false);
  });
});

describe("execCommand idle watchdog", () => {
  it("kills a silent child and reports stalled", async () => {
    const started = Date.now();
    const res = await execCommand(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
      cwd: process.cwd(),
      idleTimeoutMs: 300,
    });
    expect(res.stalled).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(res.stopped).toBe(false);
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it("does not kill a child that keeps printing", async () => {
    const script =
      "let n=0;const t=setInterval(()=>{console.log('tick');if(++n===8){clearInterval(t)}},100)";
    const res = await execCommand(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      idleTimeoutMs: 400,
    });
    expect(res.stalled).toBe(false);
    expect(res.code).toBe(0);
    expect(res.stdout.match(/tick/g)).toHaveLength(8);
  });

  it("is off by default", async () => {
    const res = await execCommand(process.execPath, ["-e", "setTimeout(()=>{},500)"], {
      cwd: process.cwd(),
    });
    expect(res.stalled).toBe(false);
    expect(res.code).toBe(0);
  });
});

describe("OpencodeTool", () => {
  let dir: string;
  let prevBin: string | undefined;

  const setup = async (script: string) => {
    prevBin = process.env.BOOF_RUNNER_OPENCODE_BIN;
    dir = await mkdtemp(join(tmpdir(), "boof-opencode-test-"));
    const bin = join(dir, "opencode");
    await writeFile(bin, `#!/bin/sh\n${script}\n`);
    await chmod(bin, 0o755);
    process.env.BOOF_RUNNER_OPENCODE_BIN = bin;
    return new OpencodeTool();
  };
  afterEach(async () => {
    if (prevBin === undefined) delete process.env.BOOF_RUNNER_OPENCODE_BIN;
    else process.env.BOOF_RUNNER_OPENCODE_BIN = prevBin;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("parses a questions block out of the text events", async () => {
    const text = "Need input.\n\n```questions\n- Which DB?\n```";
    const tool = await setup(
      `printf '%s\\n' '${JSON.stringify({ type: "text", part: { text, messageID: "m1" } })}'`,
    );
    const res = await tool.run({ ...baseOpts, role: "planner", cwd: dir });
    expect(res.questions).toEqual(["Which DB?"]);
    expect(res.report).toBe("Need input.");
  });

  it("builds args anchored to the worktree, with --auto only in auto mode", async () => {
    const tool = await setup("exit 0");
    const auto = tool.buildArgs({
      ...baseOpts,
      role: "developer",
      cwd: "/tmp/wt",
      model: "p/m",
      systemPrompt: "SYS",
      prompt: "DO",
      autoApprove: true,
    });
    expect(auto).toEqual(["run", "--format", "json", "--dir", "/tmp/wt", "-m", "p/m", "--auto"]);
    expect(tool.promptText({ ...baseOpts, systemPrompt: "SYS", prompt: "DO" })).toBe("SYS\n\nDO");
    const manual = tool.buildArgs({
      ...baseOpts,
      role: "developer",
      cwd: "/tmp/wt",
      model: "p/m",
      autoApprove: false,
    });
    expect(manual).not.toContain("--auto");
    expect(manual.slice(0, 7)).toEqual([
      "run",
      "--format",
      "json",
      "--dir",
      "/tmp/wt",
      "-m",
      "p/m",
    ]);
  });

  it("feeds the prompt through stdin, so a 300 kB prompt arrives whole", async () => {
    const tool = await setup(
      `cat > "$(dirname "$0")/stdin"\nprintf '%s\\n' '{"type":"text","part":{"text":"ok","messageID":"m1"}}'`,
    );
    const prompt = "x".repeat(300_000);
    expect(tool.buildArgs({ ...baseOpts, prompt }).some((a) => a.includes("xxxx"))).toBe(false);
    const res = await tool.run({ ...baseOpts, role: "developer", cwd: dir, prompt });
    expect(res.report).toBe("ok");
    expect(await readFile(join(dir, "stdin"), "utf8")).toBe(`sys\n\n${prompt}`);
  });

  it("passes the worktree via --dir, streams chunks and returns the report", async () => {
    const tool = await setup('printf "args:%s\\n" "$*"; printf "done\\n"');
    const chunks: string[] = [];
    const res = await tool.run({
      ...baseOpts,
      role: "developer",
      cwd: dir,
      model: "p/m",
      onChunk: (c) => chunks.push(c),
    });
    expect(res.output).toContain(`--dir ${dir}`);
    expect(res.report).toContain("done");
    expect(chunks.join("")).toContain("done");
  });

  it("parses --format json events: report, usage, ANSI-free stream", async () => {
    const tool = await setup(`cat "${fixture("opencode-json.jsonl")}"`);
    const chunks: string[] = [];
    const res = await tool.run({
      ...baseOpts,
      role: "developer",
      cwd: dir,
      onChunk: (c) => chunks.push(c),
    });
    expect(res.report).toBe("hi");
    expect(res.usage).toEqual({ inputTokens: 12681, outputTokens: 2, costUsd: 0, known: true });
    expect(chunks.join("")).toBe("hi\n");
    expect(res.output).not.toContain("\x1b[");
  });

  it("uses the last message's text and summarizes tool events", async () => {
    const ev = (o: unknown) => JSON.stringify(o);
    const lines = [
      ev({ type: "text", part: { messageID: "m1", text: "first" } }),
      ev({
        type: "tool_use",
        part: {
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: "npm test" } },
        },
      }),
      "\u001b[33mwarn\u001b[0m something",
      ev({ type: "text", part: { messageID: "m2", text: "final a" } }),
      ev({ type: "text", part: { messageID: "m2", text: "final b" } }),
    ];
    const tool = await setup(`cat <<'EOF'\n${lines.join("\n")}\nEOF`);
    const chunks: string[] = [];
    const res = await tool.run({
      ...baseOpts,
      role: "developer",
      cwd: dir,
      onChunk: (c) => chunks.push(c),
    });
    expect(res.report).toBe("final a\nfinal b");
    const live = chunks.join("");
    expect(live).toContain("[bash] npm test");
    expect(live).toContain("warn something");
    expect(live).not.toContain("\x1b[");
    expect(res.usage.known).toBe(false);
  });

  it("strips ANSI from plain-text fallback output", async () => {
    const tool = await setup(`printf '\\033[1mhello\\033[0m\\n'`);
    const res = await tool.run({ ...baseOpts, role: "developer", cwd: dir });
    expect(res.report).toBe("hello");
  });

  it("throws ToolRunError on a non-zero exit", async () => {
    const tool = await setup('echo "bad thing" >&2; exit 3');
    const err = await tool
      .run({ ...baseOpts, role: "developer", cwd: dir })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolRunError);
    expect((err as ToolRunError).code).toBe(3);
    expect((err as ToolRunError).stderr).toContain("bad thing");
    expect(isTransientToolError(err)).toBe(false);
  });

  it("maps transient API errors so the pipeline can retry", async () => {
    const tool = await setup('echo "API Error: 503 Service Unavailable" >&2; exit 1');
    const err = await tool
      .run({ ...baseOpts, role: "developer", cwd: dir })
      .catch((e: unknown) => e);
    expect(isTransientToolError(err)).toBe(true);
  });

  it("marks a stalled run via the idle timeout", async () => {
    const tool = await setup("exec sleep 30");
    const err = (await tool
      .run({ ...baseOpts, role: "developer", cwd: dir, idleTimeoutMs: 100 })
      .catch((e: unknown) => e)) as ToolRunError;
    expect(err.stalled).toBe(true);
  });

  it("lists models from `opencode models`, falling back to the default", async () => {
    const tool = await setup('printf "a/one\\nnoise\\nb/two\\n"');
    expect(await tool.listModels()).toEqual(["a/one", "b/two"]);
    const failing = await setup("exit 1");
    expect(await failing.listModels()).toEqual(["opencode-go/kimi-k3"]);
  });
});

describe("session resume", () => {
  const dirs: string[] = [];
  const envKeys = ["BOOF_RUNNER_CLAUDE_BIN", "BOOF_RUNNER_CODEX_BIN", "BOOF_RUNNER_OPENCODE_BIN"];
  const saved = new Map(envKeys.map((k) => [k, process.env[k]]));
  afterEach(async () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of dirs.splice(0))
      await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  /** A stand-in CLI that prints a fixture and records its argv next to itself. */
  const fake = async (envKey: string, name: string, fixtureName: string) => {
    const dir = await mkdtemp(join(tmpdir(), "boof-resume-test-"));
    dirs.push(dir);
    const bin = join(dir, name);
    await writeFile(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat "${fixture(fixtureName)}"\n`,
    );
    await chmod(bin, 0o755);
    process.env[envKey] = bin;
    return dir;
  };
  const opts = { ...baseOpts, role: "developer", model: "m" } as const;

  it("claude-code captures session_id and resumes with --resume", async () => {
    const dir = await fake("BOOF_RUNNER_CLAUDE_BIN", "claude", "claude-stream-json.jsonl");
    const tool = new ClaudeCodeTool();
    expect(tool.supportsResume).toBe(true);
    const fresh = tool.buildArgs(opts);
    expect(fresh).not.toContain("--resume");
    const resumed = tool.buildArgs({ ...opts, resumeSessionId: "abc-123" });
    expect(resumed).toContain("--print");
    expect(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2)).toEqual([
      "--resume",
      "abc-123",
    ]);
    expect(resumed).toContain("stream-json");
    const res = await tool.run({ ...opts, cwd: dir });
    expect(res.sessionId).toBe("6f1c2a52-9d0e-4b43-8a6e-0c1f6a7d9b11");
    expect(res.report).toBe("hi");
  });

  it("claude-code StreamRenderer takes the session id from the init event alone", () => {
    const r = new StreamRenderer(() => {});
    r.push('{"type":"system","subtype":"init","session_id":"s-1"}\n');
    expect(r.sessionId).toBe("s-1");
  });

  it("codex captures thread_id and resumes with `exec resume <id>` and only the new prompt", async () => {
    const dir = await fake("BOOF_RUNNER_CODEX_BIN", "codex", "codex-json-stdout.jsonl");
    const tool = new CodexTool();
    expect(tool.supportsResume).toBe(true);
    expect(tool.buildArgs(opts, "/tmp/last").slice(0, 2)).toEqual(["exec", "--json"]);
    const resumed = tool.buildArgs(
      { ...opts, resumeSessionId: "thread-9", prompt: "NEW" },
      "/tmp/l",
    );
    expect(resumed).toEqual([
      "exec",
      "resume",
      "thread-9",
      "--json",
      "--model",
      "m",
      "--dangerously-bypass-approvals-and-sandbox",
      "-o",
      "/tmp/l",
      "-",
    ]);
    const res = await tool.run({ ...opts, cwd: dir });
    expect(res.sessionId).toBe("01a177c2-43a8-7562-80f8-f8962f3d3215");
  });

  it("opencode captures sessionID and resumes with --session and only the new prompt", async () => {
    const dir = await fake("BOOF_RUNNER_OPENCODE_BIN", "opencode", "opencode-json.jsonl");
    const tool = new OpencodeTool();
    expect(tool.supportsResume).toBe(true);
    const resumed = tool.buildArgs({
      ...opts,
      cwd: "/tmp/wt",
      model: "p/m",
      resumeSessionId: "ses_1",
      prompt: "NEW",
    });
    expect(resumed).toEqual([
      "run",
      "--format",
      "json",
      "--dir",
      "/tmp/wt",
      "-m",
      "p/m",
      "--session",
      "ses_1",
      "--auto",
    ]);
    const res = await tool.run({ ...opts, cwd: dir });
    expect(res.sessionId).toBe("ses_e883d9495ffeYJX7kHzp41UH09");
  });

  it("a steered run fails with steered, the session id and the usage so far", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boof-resume-test-"));
    dirs.push(dir);
    const bin = join(dir, "codex");
    await writeFile(
      bin,
      `#!/bin/sh\nhead -n 1 "${fixture("codex-json-stdout.jsonl")}"\nsleep 30\n`,
    );
    await chmod(bin, 0o755);
    process.env.BOOF_RUNNER_CODEX_BIN = bin;
    const steer = join(dir, "steer");
    const running = new CodexTool().run({ ...opts, cwd: dir, steerSignalPath: steer });
    await new Promise((r) => setTimeout(r, 300));
    await writeFile(steer, "x\n");
    const err = await running.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ToolRunError);
    const e = err as ToolRunError;
    expect(e.steered).toBe(true);
    expect(e.stopped).toBe(false);
    expect(e.sessionId).toBe("01a177c2-43a8-7562-80f8-f8962f3d3215");
    expect(isTransientToolError(e)).toBe(false);
  });

  it("the mock tool reports a session id and makes a resume observable", async () => {
    const tool = new MockTool();
    expect(tool.supportsResume).toBe(true);
    const first = await tool.run({ ...opts, cwd: "/tmp" });
    expect(first.sessionId).toMatch(/^mock-session-\d+$/);
    const again = await tool.run({ ...opts, cwd: "/tmp", resumeSessionId: first.sessionId });
    expect(again.output).toContain(`resumed ${first.sessionId}`);
    expect(mockState.resumes.map((r) => r.sessionId)).toEqual([first.sessionId]);
    mockState.resumeSupported = false;
    expect(tool.supportsResume).toBe(false);
  });
});

describe("question protocol", () => {
  it("takes the last questions block, strips markers and removes it from the report", () => {
    const report = "Plan so far.\n\n```questions\n1. Which DB?\n- Which region?\n\n```\n";
    expect(parseQuestions(report)).toEqual({
      report: "Plan so far.",
      questions: ["Which DB?", "Which region?"],
    });
    expect(parseQuestions(formatQuestions(["a", "b"])).questions).toEqual(["a", "b"]);
  });
  it("parks on nothing but a block, and keeps a verdict line last", () => {
    const prose = "I have questions about style but can proceed.\nVERDICT: APPROVE";
    expect(parseQuestions(prose)).toEqual({ report: prose, questions: [] });
    const withBlock =
      "Findings.\n\n```Questions\nIs the API frozen?\n```\n\nVERDICT: CHANGES_REQUESTED";
    expect(parseQuestions(withBlock)).toEqual({
      report: "Findings.\n\nVERDICT: CHANGES_REQUESTED",
      questions: ["Is the API frozen?"],
    });
    expect(parseQuestions("```questions\n\n```").questions).toEqual([]);
  });
});

describe("ClaudeCodeTool questions", () => {
  let dir: string;
  let prevBin: string | undefined;

  const setup = async (script: string) => {
    prevBin = process.env.BOOF_RUNNER_CLAUDE_BIN;
    dir = await mkdtemp(join(tmpdir(), "boof-claude-test-"));
    const bin = join(dir, "claude");
    await writeFile(bin, `#!/bin/sh\n${script}\n`);
    await chmod(bin, 0o755);
    process.env.BOOF_RUNNER_CLAUDE_BIN = bin;
    return new ClaudeCodeTool();
  };
  afterEach(async () => {
    if (prevBin === undefined) delete process.env.BOOF_RUNNER_CLAUDE_BIN;
    else process.env.BOOF_RUNNER_CLAUDE_BIN = prevBin;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("parses a questions block out of the result event", async () => {
    const result = "Need input.\n\n```questions\n1. Which DB?\n```";
    const tool = await setup(`printf '%s\\n' '${JSON.stringify({ type: "result", result })}'`);
    const res = await tool.run({ ...baseOpts, role: "planner", cwd: dir });
    expect(res.questions).toEqual(["Which DB?"]);
    expect(res.report).toBe("Need input.");
  });
});
