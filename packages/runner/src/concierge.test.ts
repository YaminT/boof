import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConciergeAgentEvent, ConciergeTurnInput, Project, TokenUsage } from "@boof/heart";
import { ConciergeTurnError, conciergeConfigDir, conciergeScratchDir } from "@boof/heart";
import { z } from "zod";
import type { AgentAuthResolver } from "./agent-auth.js";
import { agentMarkerFor } from "./agent-marker.js";
import { DESKTOP_CLAUDE_AGENT_REASON } from "./index.js";
import type { PoolGate } from "./pool-gate.js";
import { ClaudeConcierge } from "./concierge.js";
import { fakeSdk, loadMcpSdk, type FakeStep } from "./tools/fake-agent-sdk.js";

const KEY = "sk-ant-api03-abcdefghijklmnop";
const AGENT_KEY = "sk-ant-agent-key-0123456789";
const ADMIN_KEY = "sk-ant-admin-key-0123456789";
const GATEWAY = "http://127.0.0.1:9000";
const BINARY =
  "Claude Code native binary not found (set BOOF_RUNNER_CLAUDE_AGENT_BIN or install claude)";
const DISALLOWED = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "NotebookEdit",
  "Skill",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
];
const INHERITED = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "AWS_SECRET_ACCESS_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "BOOF_SECRET",
  "BOOF_OWLISH_API_KEY",
  "BOOF_OWLISH_AGENT_KEY",
];

const project = { id: "app", name: "App", path: "/tmp/app" } as Project;
const roots: string[] = [];
const savedEnv = new Map<string, string | undefined>();

afterEach(async () => {
  vi.useRealTimers();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "boof-concierge-"));
  roots.push(dir);
  return dir;
}

function setEnv(name: string, value: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  process.env[name] = value;
}

function authStub(
  decision:
    { ok: true; via: "gateway" | "project-key"; note: null } | { ok: false; reason: string },
  credentials?:
    { kind: "project-key"; apiKey: string } | { kind: "gateway"; url: string; apiKey: string },
): AgentAuthResolver {
  return {
    decide: vi.fn(async () => decision),
    credentials: vi.fn(async () => credentials),
  } as unknown as AgentAuthResolver;
}

function poolStub(blocked = false, status = "ok"): PoolGate {
  return {
    check: vi.fn(async () => ({
      blocked,
      pool: { status },
      policy: blocked ? "pause" : null,
    })),
  } as unknown as PoolGate;
}

function input(over: Partial<ConciergeTurnInput> = {}): ConciergeTurnInput {
  return {
    project,
    systemPrompt: "Be brief.",
    prompt: "what is running?",
    model: "default",
    maxTurns: 8,
    maxBudgetUsd: 0.25,
    timeoutMs: 120_000,
    mcpServer: { marker: "mcp" },
    mcpServerName: "boof",
    allowedTools: ["mcp__boof__tasks_list"],
    ...over,
  };
}

function success(over: Record<string, unknown> = {}): FakeStep {
  return {
    emit: {
      type: "result",
      subtype: "success",
      result: "ok",
      total_cost_usd: 0,
      modelUsage: {},
      session_id: "sess",
      ...over,
    },
  };
}

const executable = async () => ({ path: "/fake-claude", source: "env" as const });

describe("ClaudeConcierge", () => {
  it("passes the restricted options", async () => {
    const root = await tempRoot();
    const mcp = { marker: "same-instance" };
    const fake = fakeSdk([success()]);
    const auth = authStub(
      { ok: true, via: "project-key", note: null },
      { kind: "project-key", apiKey: KEY },
    );
    const concierge = new ClaudeConcierge({
      root,
      auth,
      pool: poolStub(),
      loadSdk: async () => fake.sdk,
      resolveExecutable: executable,
      clientApp: "boof-runner/test",
    });
    await concierge.turn(
      input({
        mcpServer: mcp,
        resumeSessionId: "sess-9",
        allowedTools: ["mcp__boof__tasks_list", "mcp__boof__tasks_get"],
      }),
    );
    await concierge.turn(input({ model: "sonnet", mcpServer: mcp }));

    const options = fake.calls.options[0];
    const cwd = options.cwd as string;
    expect(options.tools).toEqual([]);
    expect(options.disallowedTools).toEqual(DISALLOWED);
    expect(options.mcpServers.boof.type).toBe("sdk");
    expect(options.mcpServers.boof.name).toBe("boof");
    expect(options.mcpServers.boof.instance).toBe(mcp);
    expect(options.settingSources).toEqual([]);
    expect(options.extraArgs).toEqual({ bare: null });
    expect(options.strictMcpConfig).toBe(true);
    expect(options.permissionMode).toBe("default");
    expect(options.permissionPrompts).toBe("none");
    expect(options.includePartialMessages).toBe(true);
    expect(options.maxBudgetUsd).toBe(0.25);
    expect(options.maxTurns).toBe(8);
    expect(options.resume).toBe("sess-9");
    expect(options.allowedTools).toEqual(["mcp__boof__tasks_list", "mcp__boof__tasks_get"]);
    expect(typeof options.systemPrompt).toBe("string");
    expect(options.systemPrompt).toBe("Be brief.");
    expect(options).not.toHaveProperty("model");
    expect(fake.calls.options[1].model).toBe("sonnet");
    expect(cwd.endsWith("/concierge/app/cwd")).toBe(true);
    expect(cwd).toBe(conciergeScratchDir(root, "app"));
    expect(await readdir(cwd)).toEqual([]);
    expect((await stat(cwd)).mode & 0o777).toBe(0o700);
    expect((await stat(conciergeConfigDir(root, "app"))).mode & 0o777).toBe(0o700);
    expect(options.env.CLAUDE_CONFIG_DIR).toBe(conciergeConfigDir(root, "app"));
    expect(options.env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(options.pathToClaudeCodeExecutable).toBe("/fake-claude");
    expect(options.abortController).toBeInstanceOf(AbortController);
    expect(typeof options.stderr).toBe("function");
    expect(fake.calls.prompts[0]).toBe("what is running?");
    expect((auth.decide as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      project,
      { fresh: true },
    ]);
  });

  it.each([
    ["gateway", { kind: "gateway" as const, url: GATEWAY, apiKey: AGENT_KEY }],
    ["project-key", { kind: "project-key" as const, apiKey: KEY }],
  ])("env holds only the chosen credential (%s)", async (_mode, credentials) => {
    const root = await tempRoot();
    for (const name of INHERITED) setEnv(name, "inherited-secret");
    setEnv("BOOF_OWLISH_API_KEY", ADMIN_KEY);
    setEnv("PATH", "/bin");
    const fake = fakeSdk([success()]);
    const concierge = new ClaudeConcierge({
      root,
      auth: authStub({ ok: true, via: credentials.kind, note: null }, credentials),
      pool: poolStub(),
      loadSdk: async () => fake.sdk,
      resolveExecutable: executable,
      clientApp: "boof-runner/test",
    });
    await concierge.turn(input());
    const env = fake.calls.options[0].env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe(credentials.apiKey);
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("boof-runner/test");
    expect(env.CLAUDE_CONFIG_DIR).toBe(conciergeConfigDir(root, "app"));
    expect(env.PATH).toBe("/bin");
    expect(JSON.stringify(env)).not.toContain("inherited-secret");
    expect(JSON.stringify(env)).not.toContain(ADMIN_KEY);
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(env).not.toHaveProperty("BOOF_SECRET");
    expect(env).not.toHaveProperty("BOOF_OWLISH_API_KEY");
    expect(env).not.toHaveProperty("BOOF_OWLISH_AGENT_KEY");
    expect(env.BOOF_RUNNER_AGENT_OF).toBe(agentMarkerFor(root));
    expect(Object.keys(env).filter((name) => name.startsWith("BOOF_"))).toEqual([
      "BOOF_RUNNER_AGENT_OF",
    ]);
    if (credentials.kind === "gateway") expect(env.ANTHROPIC_BASE_URL).toBe(GATEWAY);
    else expect(env).not.toHaveProperty("ANTHROPIC_BASE_URL");
  });

  it("streams text and tool events", async () => {
    const root = await tempRoot();
    const { McpServer } = loadMcpSdk();
    const mcp = new McpServer({ name: "boof", version: "0.0.0" });
    mcp.registerTool("boof_list_tasks", {}, async () => ({
      content: [{ type: "text", text: "none" }],
    }));
    const text = "Hello from the assistant, this answer is long enough to stream.";
    const fake = fakeSdk([
      {
        emit: {
          type: "system",
          subtype: "init",
          apiKeySource: "ANTHROPIC_API_KEY",
          session_id: "sess-stream",
        },
      },
      {
        emit: {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: text.slice(0, 40) },
          },
        },
      },
      {
        emit: {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: text.slice(40) },
          },
        },
      },
      { callMcp: "boof_list_tasks", args: {} },
      success({ session_id: "sess-stream" }),
    ]);
    const events: ConciergeAgentEvent[] = [];
    const concierge = new ClaudeConcierge({
      root,
      auth: authStub(
        { ok: true, via: "project-key", note: null },
        { kind: "project-key", apiKey: KEY },
      ),
      pool: poolStub(),
      loadSdk: async () => fake.sdk,
      resolveExecutable: executable,
    });
    const result = await concierge.turn(
      input({ mcpServer: mcp, onEvent: (event) => events.push(event) }),
    );
    const streamed = events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join("");
    expect(streamed).toBe(text);
    expect(result.text).toBe(text);
    expect(result.sessionId).toBe("sess-stream");
    expect(result.stopReason).toBe("done");
    expect(events.filter((event) => event.type === "tool")).toEqual([
      { type: "tool", tool: "boof_list_tasks", phase: "start" },
      { type: "tool", tool: "boof_list_tasks", phase: "end", ok: true },
    ]);
    expect(fake.calls.mcpResults[0]).toMatchObject({
      tool: "boof_list_tasks",
      args: {},
      result: { content: [{ type: "text", text: "none" }] },
    });
  });

  it("uses the given MCP instance", async () => {
    const root = await tempRoot();
    const { McpServer } = loadMcpSdk();
    const mcp = new McpServer({ name: "boof", version: "0.0.0" });
    mcp.registerTool("echo", { inputSchema: { x: z.number() } }, async ({ x }: { x: number }) => ({
      content: [{ type: "text", text: `echo:${x}` }],
    }));
    const fake = fakeSdk([
      { emit: { type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" } },
      { callMcp: "echo", args: { x: 1 } },
      success(),
    ]);
    const concierge = new ClaudeConcierge({
      root,
      auth: authStub(
        { ok: true, via: "project-key", note: null },
        { kind: "project-key", apiKey: KEY },
      ),
      pool: poolStub(),
      loadSdk: async () => fake.sdk,
      resolveExecutable: executable,
    });
    await concierge.turn(input({ mcpServer: mcp }));
    expect(fake.calls.options[0].mcpServers.boof.instance).toBe(mcp);
    expect(fake.calls.mcpResults[0].result).toMatchObject({
      content: [{ type: "text", text: "echo:1" }],
    });
  });

  it("subtracts the resume baseline", async () => {
    const root = await tempRoot();
    const baseline: TokenUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0.1, known: true };
    const fake = fakeSdk([
      success({
        total_cost_usd: 0.3,
        modelUsage: { m: { inputTokens: 4, outputTokens: 2, costBasis: "list" } },
      }),
    ]);
    const concierge = new ClaudeConcierge({
      root,
      auth: authStub(
        { ok: true, via: "project-key", note: null },
        { kind: "project-key", apiKey: KEY },
      ),
      pool: poolStub(),
      loadSdk: async () => fake.sdk,
      resolveExecutable: executable,
    });
    const result = await concierge.turn(input({ resumeBaseline: baseline }));
    expect(result.usage.costUsd).toBeCloseTo(0.2);
    expect(result.usage.known).toBe(true);
    expect(result.cumulative.costUsd).toBeCloseTo(0.3);
    expect(result.cumulative.inputTokens).toBe(4);
    expect(result.cumulative.outputTokens).toBe(2);
    expect(result.usage.inputTokens).toBe(4);
    expect(result.stopReason).toBe("done");
  });

  it("max budget and max turns end with the text so far", async () => {
    const root = await tempRoot();
    const kept = "partial answer that is already longer than the api key buffer";
    const run = async (subtype: string) => {
      const fake = fakeSdk([
        { emit: { type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" } },
        {
          emit: {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: kept } },
          },
        },
        {
          emit: {
            type: "result",
            subtype,
            result: "HIDDEN",
            total_cost_usd: 0.25,
            modelUsage: { m: { inputTokens: 2, outputTokens: 1, costBasis: "list" } },
            session_id: "sess-cap",
          },
        },
      ]);
      const concierge = new ClaudeConcierge({
        root,
        auth: authStub(
          { ok: true, via: "project-key", note: null },
          { kind: "project-key", apiKey: KEY },
        ),
        pool: poolStub(),
        loadSdk: async () => fake.sdk,
        resolveExecutable: executable,
      });
      return concierge.turn(input());
    };
    const budget = await run("error_max_budget_usd");
    expect(budget.stopReason).toBe("max_budget");
    expect(budget.text).toBe(kept);
    expect(budget.text).not.toContain("HIDDEN");
    expect(budget.usage).toMatchObject({
      costUsd: 0.25,
      inputTokens: 2,
      outputTokens: 1,
      known: true,
    });
    const turns = await run("error_max_turns");
    expect(turns.stopReason).toBe("max_turns");
    expect(turns.text).toBe(kept);
    expect(turns.usage.known).toBe(true);
  });

  it("refuses a session without API-key auth", async () => {
    const root = await tempRoot();
    const fake = fakeSdk([
      { emit: { type: "system", subtype: "init", apiKeySource: "none", session_id: "s-bad" } },
    ]);
    const concierge = new ClaudeConcierge({
      root,
      auth: authStub(
        { ok: true, via: "project-key", note: null },
        { kind: "project-key", apiKey: KEY },
      ),
      pool: poolStub(),
      loadSdk: async () => fake.sdk,
      resolveExecutable: executable,
    });
    const error = await concierge.turn(input()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConciergeTurnError);
    const refused = error as ConciergeTurnError;
    expect(refused.kind).toBe("refused");
    expect(refused.usage).toBeNull();
    expect(refused.sessionId).toBe("s-bad");
    expect(refused.message).toBe(
      "assistant refused: the session did not authenticate with an API key (apiKeySource=none)",
    );
    expect(fake.calls.closed).toBe(1);
  });

  it("abort and timeout carry usage", async () => {
    const root = await tempRoot();
    const unknown: TokenUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, known: false };
    const hang = (): FakeStep[] => [
      {
        emit: {
          type: "system",
          subtype: "init",
          apiKeySource: "ANTHROPIC_API_KEY",
          session_id: "sess-wait",
        },
      },
      "hang",
    ];
    const make = (fake: ReturnType<typeof fakeSdk>) =>
      new ClaudeConcierge({
        root,
        auth: authStub(
          { ok: true, via: "project-key", note: null },
          { kind: "project-key", apiKey: KEY },
        ),
        pool: poolStub(),
        loadSdk: async () => fake.sdk,
        resolveExecutable: executable,
      });

    const timed = fakeSdk(hang());
    const timedOut = await make(timed)
      .turn(input({ timeoutMs: 30 }))
      .catch((caught: unknown) => caught);
    expect(timedOut).toBeInstanceOf(ConciergeTurnError);
    expect(timedOut).toMatchObject({
      kind: "timeout",
      message: "assistant timed out",
      usage: unknown,
      sessionId: "sess-wait",
    });
    expect(timed.calls.closed).toBe(1);

    const abortedSdk = fakeSdk(hang());
    const signal = new AbortController();
    const pending = make(abortedSdk)
      .turn(input({ signal: signal.signal }))
      .catch((caught: unknown) => caught);
    await new Promise((resolve) => setTimeout(resolve, 20));
    signal.abort();
    const aborted = await pending;
    expect(aborted).toBeInstanceOf(ConciergeTurnError);
    expect(aborted).toMatchObject({
      kind: "aborted",
      message: "assistant aborted",
      usage: unknown,
      sessionId: "sess-wait",
    });
    expect(abortedSdk.calls.closed).toBe(1);
  });

  it("redacts the key from text deltas and error messages", async () => {
    const root = await tempRoot();
    const mid = Math.ceil(KEY.length / 2);
    const fake = fakeSdk([
      {
        emit: {
          type: "system",
          subtype: "init",
          apiKeySource: "ANTHROPIC_API_KEY",
          session_id: "s",
        },
      },
      {
        emit: {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: KEY.slice(0, mid) },
          },
        },
      },
      {
        emit: {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: KEY.slice(mid) },
          },
        },
      },
      {
        emit: {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [`failed ${KEY}`],
          total_cost_usd: 0.05,
          modelUsage: {},
          session_id: "s",
        },
      },
    ]);
    const events: ConciergeAgentEvent[] = [];
    const concierge = new ClaudeConcierge({
      root,
      auth: authStub(
        { ok: true, via: "project-key", note: null },
        { kind: "project-key", apiKey: KEY },
      ),
      pool: poolStub(),
      loadSdk: async () => fake.sdk,
      resolveExecutable: executable,
    });
    const error = await concierge
      .turn(input({ onEvent: (event) => events.push(event) }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConciergeTurnError);
    const failed = error as ConciergeTurnError;
    expect(failed.kind).toBe("failed");
    expect(failed.sessionId).toBe("s");
    expect(failed.usage).toMatchObject({ costUsd: 0.05, known: true });
    expect(failed.message).toContain("[redacted]");
    expect(failed.message).not.toContain(KEY);
    const streamed = events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join("");
    expect(streamed).toContain("[redacted]");
    expect(streamed).not.toContain(KEY);
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it("two concurrent turns keep their working directory", async () => {
    const root = await tempRoot();
    const scratch = conciergeScratchDir(root, "app");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const seen: { cwd: string; marker: boolean; inode: number }[] = [];
    const sdkFor = (wait: boolean) =>
      ({
        query: (params: { options: { cwd: string } }) => {
          started++;
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" };
              if (wait) await gate;
              const marker = await stat(join(params.options.cwd, "marker")).then(
                () => true,
                () => false,
              );
              const inode = (await stat(params.options.cwd)).ino;
              seen.push({ cwd: params.options.cwd, marker, inode });
              yield {
                type: "result",
                subtype: "success",
                result: "ok",
                total_cost_usd: 0,
                modelUsage: {},
                session_id: "sess",
              };
            },
            close() {},
          };
        },
      }) as never;
    const make = (wait: boolean) =>
      new ClaudeConcierge({
        root,
        auth: authStub(
          { ok: true, via: "project-key", note: null },
          { kind: "project-key", apiKey: KEY },
        ),
        pool: poolStub(),
        loadSdk: async () => sdkFor(wait),
        resolveExecutable: executable,
      });
    const first = make(true).turn(input());
    for (
      let i = 0;
      i < 100 &&
      !(await stat(scratch).then(
        () => true,
        () => false,
      ));
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(join(scratch, "marker"), "x");
    const inode = (await stat(scratch)).ino;
    const second = await make(false).turn(input());
    expect(second.text).toBe("");
    release();
    const done = await first;
    expect(done.stopReason).toBe("done");
    expect(seen).toHaveLength(2);
    for (const entry of seen) {
      expect(entry.cwd).toBe(scratch);
      expect(entry.marker).toBe(true);
      expect(entry.inode).toBe(inode);
    }
    // Idle again: the next turn clears stale files, still in the same directory.
    await make(false).turn(input());
    expect(await readdir(scratch)).toEqual([]);
    expect((await stat(scratch)).ino).toBe(inode);
  });

  it("setup failures are ConciergeTurnErrors", async () => {
    const root = await tempRoot();
    const fake = fakeSdk([success()]);
    const failing = new ClaudeConcierge({
      root,
      auth: authStub(
        { ok: true, via: "gateway", note: null },
        { kind: "gateway", url: GATEWAY, apiKey: "" },
      ),
      pool: poolStub(),
      loadSdk: async () => fake.sdk,
      resolveExecutable: executable,
    });
    const error = await failing.turn(input()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConciergeTurnError);
    expect(error).toMatchObject({ kind: "failed", usage: null, sessionId: null });
    expect(fake.calls.options).toEqual([]);
  });

  it("an abort before anything ran carries no usage", async () => {
    const root = await tempRoot();
    const fake = fakeSdk([success()]);
    const controller = new AbortController();
    controller.abort();
    const error = await new ClaudeConcierge({
      root,
      auth: authStub(
        { ok: true, via: "project-key", note: null },
        { kind: "project-key", apiKey: KEY },
      ),
      pool: poolStub(),
      loadSdk: async () => fake.sdk,
      resolveExecutable: executable,
    })
      .turn(input({ signal: controller.signal }))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "aborted", usage: null, sessionId: null });
    expect(fake.calls.options).toEqual([]);
  });

  it("drops tool names that are not plain identifiers", async () => {
    const root = await tempRoot();
    const events: ConciergeAgentEvent[] = [];
    const fake = fakeSdk([
      {
        emit: {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t1", name: `mcp__boof__${KEY}`, input: {} },
              { type: "tool_use", id: "t2", name: "mcp__boof__tasks_list", input: {} },
            ],
          },
        },
      },
      success(),
    ]);
    await new ClaudeConcierge({
      root,
      auth: authStub(
        { ok: true, via: "project-key", note: null },
        { kind: "project-key", apiKey: KEY },
      ),
      pool: poolStub(),
      loadSdk: async () => fake.sdk,
      resolveExecutable: executable,
    }).turn(input({ onEvent: (event) => events.push(event) }));
    expect(events).toEqual([{ type: "tool", tool: "tasks_list", phase: "start" }]);
  });

  it("the fake MCP client lists tools before calling one", async () => {
    const { McpServer } = loadMcpSdk();
    const server = new McpServer({ name: "boof", version: "0.0.0" });
    server.registerTool(
      "echo",
      {
        inputSchema: { text: z.string() },
        outputSchema: { n: z.number() },
      },
      (() => ({
        content: [{ type: "text", text: "x" }],
        structuredContent: { n: "bad" },
      })) as never,
    );
    const fake = fakeSdk([{ callMcp: "echo", args: { text: "hi" } }, success()]);
    const turn = new ClaudeConcierge({
      root: await tempRoot(),
      auth: authStub(
        { ok: true, via: "project-key", note: null },
        { kind: "project-key", apiKey: KEY },
      ),
      pool: poolStub(),
      loadSdk: async () => fake.sdk,
      resolveExecutable: executable,
    }).turn(input({ mcpServer: server }));
    await turn;
    // An output that breaks the declared schema is an error result, as with a real client.
    expect((fake.calls.mcpResults[0]!.result as { isError?: boolean }).isError).toBe(true);
  });

  it("redacts a key split over three deltas", async () => {
    const root = await tempRoot();
    const a = Math.floor(KEY.length / 3);
    const b = Math.floor((KEY.length * 2) / 3);
    const delta = (text: string): FakeStep => ({
      emit: {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text } },
      },
    });
    const fake = fakeSdk([
      delta(`key ${KEY.slice(0, a)}`),
      delta(KEY.slice(a, b)),
      delta(`${KEY.slice(b)} end`),
      success(),
    ]);
    const result = await new ClaudeConcierge({
      root,
      auth: authStub(
        { ok: true, via: "project-key", note: null },
        { kind: "project-key", apiKey: KEY },
      ),
      pool: poolStub(),
      loadSdk: async () => fake.sdk,
      resolveExecutable: executable,
    }).turn(input());
    expect(result.text).not.toContain(KEY.slice(0, 12));
    expect(result.text).toContain("[redacted]");
  });

  it("availability fails closed in order and never sends a prompt", async () => {
    const root = await tempRoot();
    const sleep = vi.fn(async () => {
      throw new Error("sleep called");
    });

    const unavailableLoad = vi.fn();
    const unavailableDecide = vi.fn();
    const unavailableExe = vi.fn();
    const unavailablePool = vi.fn();
    const unavailable = new ClaudeConcierge({
      root,
      unavailableReason: DESKTOP_CLAUDE_AGENT_REASON,
      loadSdk: unavailableLoad,
      resolveExecutable: unavailableExe,
      auth: { decide: unavailableDecide } as unknown as AgentAuthResolver,
      pool: { check: unavailablePool } as unknown as PoolGate,
    });
    expect(await unavailable.availability(project)).toEqual({
      available: false,
      reason: DESKTOP_CLAUDE_AGENT_REASON,
      via: null,
    });
    expect(unavailableLoad).not.toHaveBeenCalled();
    expect(unavailableDecide).not.toHaveBeenCalled();
    expect(unavailableExe).not.toHaveBeenCalled();
    expect(unavailablePool).not.toHaveBeenCalled();

    const loaderDecide = vi.fn();
    const loaderExe = vi.fn();
    const loaderFailed = new ClaudeConcierge({
      root,
      loadSdk: async () => {
        throw new Error("the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) is not installed");
      },
      resolveExecutable: loaderExe,
      auth: { decide: loaderDecide } as unknown as AgentAuthResolver,
      pool: poolStub(),
    });
    expect(await loaderFailed.availability(project)).toEqual({
      available: false,
      reason: "the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) is not installed",
      via: null,
    });
    expect(loaderExe).not.toHaveBeenCalled();
    expect(loaderDecide).not.toHaveBeenCalled();

    const missingDecide = vi.fn();
    const missing = new ClaudeConcierge({
      root,
      loadSdk: async () => fakeSdk([]).sdk,
      resolveExecutable: async () => ({ path: undefined, source: null }),
      auth: { decide: missingDecide } as unknown as AgentAuthResolver,
      pool: poolStub(),
    });
    expect(await missing.availability(project)).toEqual({
      available: false,
      reason: BINARY,
      via: null,
    });
    expect(missingDecide).not.toHaveBeenCalled();

    const refusedPool = vi.fn();
    const refused = new ClaudeConcierge({
      root,
      loadSdk: async () => fakeSdk([]).sdk,
      resolveExecutable: executable,
      auth: authStub({ ok: false, reason: "claude-agent cannot start: no key" }),
      pool: { check: refusedPool } as unknown as PoolGate,
    });
    expect(await refused.availability(project)).toEqual({
      available: false,
      reason: "claude-agent cannot start: no key",
      via: null,
    });
    expect(refusedPool).not.toHaveBeenCalled();

    vi.useFakeTimers();
    const unreachableCheck = vi.fn(async () => {
      await sleep(30_000);
      return { blocked: true, pool: { status: "unreachable" }, policy: "pause" };
    });
    const unreachable = new ClaudeConcierge({
      root,
      loadSdk: async () => fakeSdk([]).sdk,
      resolveExecutable: executable,
      auth: {
        decide: vi.fn(async () => ({ ok: false, unreachable: true, reason: "slow" })),
      } as unknown as AgentAuthResolver,
      pool: { check: unreachableCheck, sleep } as unknown as PoolGate,
    });
    expect(await unreachable.availability(project)).toEqual({
      available: false,
      reason: "the better-ccflare gateway is unreachable; try again shortly",
      via: null,
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(unreachableCheck).not.toHaveBeenCalled();
    vi.useRealTimers();

    const blocked = new ClaudeConcierge({
      root,
      loadSdk: async () => fakeSdk([]).sdk,
      resolveExecutable: executable,
      auth: authStub({ ok: true, via: "gateway", note: null }),
      pool: poolStub(true, "degraded"),
    });
    expect(await blocked.availability(project)).toEqual({
      available: false,
      reason: "the account pool is paused or exhausted (degraded)",
      via: null,
    });

    const fake = fakeSdk([success()]);
    const ready = new ClaudeConcierge({
      root,
      loadSdk: async () => fake.sdk,
      resolveExecutable: executable,
      auth: authStub({ ok: true, via: "gateway", note: null }),
      pool: poolStub(false, "ok"),
    });
    expect(await ready.availability(project)).toEqual({
      available: true,
      reason: null,
      via: "gateway",
    });
    expect(fake.calls.options).toEqual([]);
    expect(fake.calls.prompts).toEqual([]);

    const keyPool = vi.fn();
    const viaKey = new ClaudeConcierge({
      root,
      loadSdk: async () => fakeSdk([]).sdk,
      resolveExecutable: executable,
      auth: authStub({ ok: true, via: "project-key", note: null }),
      pool: { check: keyPool } as unknown as PoolGate,
    });
    expect(await viaKey.availability(project)).toEqual({
      available: true,
      reason: null,
      via: "project-key",
    });
    expect(keyPool).not.toHaveBeenCalled();
  });
});
