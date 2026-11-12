import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConciergeTurnError,
  SettingsStore,
  conciergeDir,
  defaultSettings,
  type ConciergeAgent,
  type ConciergeAgentEvent,
  type ConciergeBridge,
  type ConciergeTurnInput,
  type Project,
  type Settings,
} from "@boof/heart";
import {
  AutoConcierge,
  ClaudeCodeConcierge,
  NOT_INSTALLED_REASON,
  NO_ASSISTANT_REASON,
  NO_BRIDGE_REASON,
  parseCapabilities,
} from "./concierge-claude-code.js";
import { DISALLOWED_TOOLS } from "./concierge.js";

const FAKE = fileURLToPath(
  new URL("./tools/__fixtures__/fake-claude-concierge.mjs", import.meta.url),
);
const project = { id: "app", name: "App", path: "/tmp/app" } as Project;
const HELP_FLAGS = [
  "--output-format",
  "--verbose",
  "--include-partial-messages",
  "--mcp-config",
  "--strict-mcp-config",
  "--allowedTools",
  "--disallowedTools",
  "--setting-sources",
  "--system-prompt",
  "--tools",
];

let root: string;
let logFile: string;
let settings: Settings;
const savedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined) {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-cc-concierge-"));
  logFile = join(root, "fake.log");
  settings = defaultSettings();
  await new SettingsStore(root).save(settings);
  setEnv("CLAUDE_FAKE_LOG", logFile);
});

afterEach(async () => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function agent(bin = FAKE) {
  return new ClaudeCodeConcierge({ root, bin, cacheMs: 0 });
}

async function logs(): Promise<Record<string, unknown>[]> {
  if (!existsSync(logFile)) return [];
  return (await readFile(logFile, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface FakeBridge extends ConciergeBridge {
  opened: number;
  closed: number;
}
function bridge(url = "http://127.0.0.1:9/mcp/concierge/t1"): FakeBridge {
  const b: FakeBridge = {
    opened: 0,
    closed: 0,
    open: () => {
      b.opened++;
      return { url, token: "a".repeat(64), close: () => void b.closed++ };
    },
  };
  return b;
}

function turnInput(overrides: Partial<ConciergeTurnInput> = {}): ConciergeTurnInput {
  return {
    project,
    systemPrompt: "You are the assistant.",
    prompt: "what is going on?",
    model: "default",
    maxTurns: 8,
    maxBudgetUsd: 0.25,
    timeoutMs: 20_000,
    mcpServer: {},
    mcpServerName: "boof",
    allowedTools: ["mcp__boof__boof_list_tasks", "mcp__boof__boof_create_task"],
    bridge: bridge(),
    ...overrides,
  };
}

const turnDirs = async () =>
  (await readdir(conciergeDir(root, "app")).catch(() => [])).filter((n) => n.startsWith("turn-"));

describe("parseCapabilities", () => {
  const help = HELP_FLAGS.map((f) => `  ${f}  text`).join("\n");

  it("accepts a help text naming every required flag", () => {
    expect(parseCapabilities(help)).toEqual({ missing: null, maxBudget: false, maxTurns: false });
  });

  it("names the first missing flag", () => {
    for (const flag of HELP_FLAGS) {
      const without = help
        .split("\n")
        .filter((line) => !line.includes(`${flag} `))
        .join("\n");
      expect(parseCapabilities(without).missing).toBe(flag);
    }
  });

  it("takes either spelling of the tool list flags and sees the optional flags", () => {
    const text = help
      .replace("--allowedTools", "--allowed-tools")
      .replace("--disallowedTools", "--disallowed-tools");
    expect(parseCapabilities(`${text}\n  --max-budget-usd <n>\n  --max-turns <n>`)).toEqual({
      missing: null,
      maxBudget: true,
      maxTurns: true,
    });
  });

  it("does not take a longer flag for a required one", () => {
    expect(parseCapabilities(help.replace("--tools", "--tools-extra")).missing).toBe("--tools");
  });
});

describe.skipIf(process.platform === "win32")("ClaudeCodeConcierge", () => {
  it("is unavailable, naming the program, when claude is not installed", async () => {
    const result = await agent(join(root, "no-such-claude")).availability(project, {
      bridge: true,
    });
    expect(result).toMatchObject({ available: false, via: null });
    expect(result.reason).toContain(NOT_INSTALLED_REASON);
  });

  it("is unavailable without the server's loopback endpoint", async () => {
    expect((await agent().availability(project, { bridge: false })).reason).toBe(NO_BRIDGE_REASON);
    expect((await agent().availability(project)).reason).toBe(NO_BRIDGE_REASON);
  });

  it("is unavailable, naming the flag, when the CLI lacks a required one", async () => {
    setEnv("CLAUDE_FAKE_HELP_OMIT", "--setting-sources");
    const result = await agent().availability(project, { bridge: true });
    expect(result.available).toBe(false);
    expect(result.reason).toContain("--setting-sources");
    expect(result.reason).toContain("2.9.9");
  });

  it("is available through claude-code, and never sends a prompt to find out", async () => {
    expect(await agent().availability(project, { bridge: true })).toEqual({
      available: true,
      reason: null,
      via: "claude-code",
    });
    expect(await logs()).toEqual([]);
  });

  it("runs one headless turn with no built-in tools, no user settings and a private config file", async () => {
    const b = bridge();
    const events: ConciergeAgentEvent[] = [];
    const result = await agent().turn(
      turnInput({
        model: "sonnet",
        resumeSessionId: "sess-0",
        bridge: b,
        onEvent: (e) => events.push(e),
      }),
    );
    expect(result).toMatchObject({
      text: "Hello from fake claude.",
      sessionId: "sess-1",
      stopReason: "done",
      usage: { costUsd: 0.02, known: true, inputTokens: 10, outputTokens: 5 },
    });
    expect(events).toEqual([{ type: "text", text: "Hello from fake claude." }]);
    const [entry] = await logs();
    const argv = entry!.argv as string[];
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(argv).toContain("--strict-mcp-config");
    expect(after("--output-format")).toBe("stream-json");
    expect(after("--tools")).toBe("");
    expect(after("--setting-sources")).toBe("");
    expect(after("--model")).toBe("sonnet");
    expect(after("--resume")).toBe("sess-0");
    expect(after("--system-prompt")).toBe("You are the assistant.");
    expect(after("--allowedTools")).toBe("mcp__boof__boof_list_tasks,mcp__boof__boof_create_task");
    expect(after("--disallowedTools")).toBe(DISALLOWED_TOOLS.join(","));
    expect(after("--max-budget-usd")).toBe("0.25");
    expect(after("--max-turns")).toBe("8");
    expect(entry!.prompt).toBe("what is going on?");
    expect(entry!.cwd).toMatch(/concierge[\\/]app[\\/]cwd$/);
    // The endpoint and its token are in the 0600 file only.
    expect(entry!.configMode).toBe(0o600);
    expect(argv.join(" ")).not.toContain("a".repeat(64));
    expect(argv.join(" ")).not.toContain("127.0.0.1:9");
    expect(entry!.token).toBe("a".repeat(64));
    // And gone after the turn, with the lease closed.
    expect(existsSync(entry!.configPath as string)).toBe(false);
    expect(await turnDirs()).toEqual([]);
    expect(b).toMatchObject({ opened: 1, closed: 1 });
  });

  it("subtracts the resume baseline from the turn's usage", async () => {
    const result = await agent().turn(
      turnInput({
        resumeBaseline: { inputTokens: 4, outputTokens: 2, costUsd: 0.01, known: true },
      }),
    );
    expect(result.usage).toMatchObject({ costUsd: 0.01, inputTokens: 6, outputTokens: 3 });
    expect(result.cumulative).toMatchObject({ costUsd: 0.02, inputTokens: 10 });
  });

  it("does not hand the server's gateway or boof variables to the CLI", async () => {
    setEnv("ANTHROPIC_BASE_URL", "http://127.0.0.1:8080");
    setEnv("ANTHROPIC_AUTH_TOKEN", "admin-token-0123456789");
    setEnv("BOOF_SECRET", "boof-only");
    setEnv("AWS_SECRET_ACCESS_KEY", "aws-only");
    await agent().turn(turnInput());
    const [entry] = await logs();
    expect(entry).toMatchObject({ baseUrl: null, authToken: null });
    expect(entry!.envKeys).not.toContain("BOOF_SECRET");
    expect(entry!.envKeys).not.toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("leaves --max-turns and --max-budget-usd off when the CLI does not list them", async () => {
    setEnv("CLAUDE_FAKE_HELP_OMIT", "--max-turns,--max-budget-usd");
    await agent().turn(turnInput());
    const argv = (await logs())[0]!.argv as string[];
    expect(argv).not.toContain("--max-turns");
    expect(argv).not.toContain("--max-budget-usd");
  });

  it("reports max_budget when the cost reached the cap and the CLI cannot enforce it", async () => {
    setEnv("CLAUDE_FAKE_HELP_OMIT", "--max-budget-usd");
    const result = await agent().turn(turnInput({ maxBudgetUsd: 0.02 }));
    expect(result.stopReason).toBe("max_budget");
  });

  it("scrubs the turn's token from the answer", async () => {
    setEnv("CLAUDE_FAKE_MODE", "leak");
    const result = await agent().turn(turnInput());
    expect(result.text).not.toContain("a".repeat(64));
    expect(result.text).toContain("the token is");
  });

  it("maps tool calls to events", async () => {
    const calls: string[] = [];
    const http: Server = createServer((req, res) => {
      calls.push(`${req.method} ${req.url} ${req.headers.authorization?.slice(0, 12)}`);
      req.resume();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = http.address() as { port: number };
      setEnv("CLAUDE_FAKE_MODE", "tool");
      setEnv("CLAUDE_FAKE_TOOL", "boof_create_task");
      setEnv("CLAUDE_FAKE_ARGS", JSON.stringify({ title: "Fix X" }));
      const events: ConciergeAgentEvent[] = [];
      await agent().turn(
        turnInput({
          bridge: bridge(`http://127.0.0.1:${port}/mcp/concierge/t1`),
          onEvent: (e) => events.push(e),
        }),
      );
      expect(calls).toEqual(["POST /mcp/concierge/t1 Bearer aaaaa"]);
      expect(events).toEqual([
        { type: "tool", tool: "boof_create_task", phase: "start" },
        { type: "tool", tool: "boof_create_task", phase: "end", ok: true },
        { type: "text", text: "Done." },
      ]);
    } finally {
      await new Promise((resolve) => http.close(resolve));
    }
  });

  it("fails with the CLI's own message, keeps its usage out, and cleans up", async () => {
    setEnv("CLAUDE_FAKE_MODE", "fail");
    const b = bridge();
    const error = await agent()
      .turn(turnInput({ bridge: b }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConciergeTurnError);
    expect(error).toMatchObject({ kind: "failed" });
    expect((error as Error).message).toContain("Not logged in");
    expect(await turnDirs()).toEqual([]);
    expect(b.closed).toBe(1);
  });

  it("stops the CLI on abort, and cleans up", async () => {
    setEnv("CLAUDE_FAKE_MODE", "hang");
    const b = bridge();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 700);
    const error = await agent()
      .turn(turnInput({ bridge: b, signal: controller.signal }))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "aborted" });
    expect(await turnDirs()).toEqual([]);
    expect(b.closed).toBe(1);
  });

  it("times out and cleans up", async () => {
    setEnv("CLAUDE_FAKE_MODE", "hang");
    const b = bridge();
    const error = await agent()
      .turn(turnInput({ bridge: b, timeoutMs: 700 }))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "timeout" });
    expect(await turnDirs()).toEqual([]);
    expect(b.closed).toBe(1);
  });

  it("refuses a turn that was given no endpoint", async () => {
    const error = await agent()
      .turn(turnInput({ bridge: undefined }))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "refused", message: NO_BRIDGE_REASON });
  });
});

describe("AutoConcierge", () => {
  const ok = { available: true, reason: null, via: "gateway" as const };
  const code = { available: true, reason: null, via: "claude-code" as const };
  const result = (via: string) => ({
    text: via,
    sessionId: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, known: true },
    cumulative: { inputTokens: 0, outputTokens: 0, costUsd: 0, known: true },
    stopReason: "done" as const,
  });
  function stub(name: string, availability: Awaited<ReturnType<ConciergeAgent["availability"]>>) {
    const calls = { availability: 0, turn: 0 };
    const stubbed: ConciergeAgent = {
      availability: async () => (calls.availability++, availability),
      turn: async () => (calls.turn++, result(name)),
    };
    return { stubbed, calls };
  }
  const withTool = (tool?: "auto" | "claude-agent" | "claude-code") => async () =>
    ({
      ...defaultSettings(),
      ...(tool ? { concierge: { tool } } : {}),
    }) as Settings;

  async function build(
    tool: "auto" | "claude-agent" | "claude-code" | undefined,
    a: Awaited<ReturnType<ConciergeAgent["availability"]>>,
    c: Awaited<ReturnType<ConciergeAgent["availability"]>>,
  ) {
    const sdk = stub("sdk", a);
    const cli = stub("cli", c);
    const auto = new AutoConcierge({
      agent: sdk.stubbed,
      code: cli.stubbed,
      loadSettings: withTool(tool),
    });
    return { auto, sdk, cli };
  }
  const gone = { available: false, reason: "no", via: null };
  const desktop = { ...gone, reason: "claude-agent is not available in the desktop app" };
  const missing = { ...gone, reason: `${NOT_INSTALLED_REASON}: \`claude\` not found on PATH` };

  it("auto uses claude-agent when it is available", async () => {
    const { auto, cli } = await build(undefined, ok, code);
    expect(await auto.availability(project, { bridge: true })).toEqual(ok);
    expect((await auto.turn(turnInput())).text).toBe("sdk");
    expect(cli.calls.turn).toBe(0);
  });

  it("auto falls back to claude-code when claude-agent is not available", async () => {
    const { auto, sdk } = await build("auto", desktop, code);
    expect(await auto.availability(project, { bridge: true })).toEqual(code);
    expect((await auto.turn(turnInput())).text).toBe("cli");
    expect(sdk.calls.turn).toBe(0);
  });

  it("auto says no assistant harness is installed, with both reasons", async () => {
    const { auto } = await build("auto", desktop, missing);
    const answer = await auto.availability(project, { bridge: true });
    expect(answer.available).toBe(false);
    expect(answer.reason).toContain(NO_ASSISTANT_REASON);
    expect(answer.reason).toContain("desktop app");
    expect(answer.reason).toContain(NOT_INSTALLED_REASON);
    await expect(auto.turn(turnInput())).rejects.toMatchObject({ kind: "refused" });
  });

  it("auto reports claude-code's own reason when it is installed but cannot run", async () => {
    const { auto } = await build("auto", desktop, { ...gone, reason: NO_BRIDGE_REASON });
    expect((await auto.availability(project, { bridge: false })).reason).toBe(NO_BRIDGE_REASON);
  });

  it("claude-agent never looks at claude-code", async () => {
    const { auto, cli } = await build("claude-agent", desktop, code);
    expect((await auto.availability(project)).available).toBe(false);
    expect(cli.calls.availability).toBe(0);
  });

  it("claude-code never looks at claude-agent", async () => {
    const { auto, sdk } = await build("claude-code", ok, code);
    expect(await auto.availability(project, { bridge: true })).toEqual(code);
    expect((await auto.turn(turnInput())).text).toBe("cli");
    expect(sdk.calls.availability + sdk.calls.turn).toBe(0);
  });
});
