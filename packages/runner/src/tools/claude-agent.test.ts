import { describe, expect, it, vi } from "vitest";
import { ClaudeAgentTool, usageFromSdkResult } from "./claude-agent.js";
import { fakeSdk } from "./fake-agent-sdk.js";
import { AgentAuthRefusedError } from "../agent-auth.js";
import { DESKTOP_CLAUDE_AGENT_REASON } from "../index.js";
import { ToolRunError, isTransientToolError } from "./errors.js";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  env: {
    ANTHROPIC_API_KEY: "fake-gateway-key",
    CLAUDE_CONFIG_DIR: "/tmp/boof-data/claude-agent-config/project",
  },
};
const msg = (type: string, data: Record<string, unknown> = {}) => ({ type, ...data });

/** Poll until `path` exists. The bound is only a failure deadline, not the behavior under test. */
async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function procState(pid: number): Promise<string> {
  try {
    return (await readFile(`/proc/${pid}/stat`, "utf8")).split(" ")[2] ?? "";
  } catch {
    return "";
  }
}

/**
 * Keep ClaudeAgentTool's kill timer (timeout or idle) from firing until `arm` resolves.
 * Those timers are scheduled as soon as `run()` starts, which is before the detached
 * child has spawned its grandchild. Other timers, including process-group polling, stay real.
 */
function holdAgentKillTimer(delayMs: number, arm: Promise<void>) {
  const origSet = globalThis.setTimeout;
  const origClear = globalThis.clearTimeout;
  let armed = false;
  const pending = new Map<
    number,
    { fn: TimerHandler; args: unknown[]; timer?: ReturnType<typeof setTimeout> }
  >();
  let seq = 1;
  let skipped = "";
  const matches = (ms: number | undefined) => {
    if (armed || ms !== delayMs) return false;
    const stack = new Error().stack ?? "";
    const fromAgent = stack.includes("/claude-agent.ts") || stack.includes("claude-agent.ts:");
    if (!fromAgent) skipped = stack;
    return fromAgent;
  };
  globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (!matches(ms)) return origSet(fn as (...a: unknown[]) => void, ms, ...(args as []));
    const id = seq++;
    pending.set(id, { fn, args });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
    if (typeof id === "number" && pending.has(id)) {
      const rec = pending.get(id);
      pending.delete(id);
      if (rec?.timer) origClear(rec.timer);
      return;
    }
    origClear(id as never);
  }) as typeof clearTimeout;
  void arm.then(() => {
    armed = true;
    for (const [id, rec] of [...pending]) {
      if (!pending.has(id) || rec.timer) continue;
      rec.timer = origSet(rec.fn as (...a: unknown[]) => void, delayMs, ...(rec.args as []));
    }
  });
  return {
    pending: () => pending.size,
    skipped: () => skipped,
    restore() {
      globalThis.setTimeout = origSet;
      globalThis.clearTimeout = origClear;
      for (const rec of pending.values()) if (rec.timer) origClear(rec.timer);
      pending.clear();
    },
  };
}

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

  it("subtracts resumed cumulative usage, but keeps totals when the baseline is larger", () => {
    const modelUsage = { m: { inputTokens: 20, cacheReadInputTokens: 10, outputTokens: 8 } };
    expect(
      usageFromSdkResult(
        { total_cost_usd: 1, modelUsage },
        { inputTokens: 0, outputTokens: 0, costUsd: 0.4, known: true },
      ),
    ).toMatchObject({ costUsd: 0.6, inputTokens: 30, outputTokens: 8 });
    expect(
      usageFromSdkResult(
        { total_cost_usd: 1, modelUsage },
        { inputTokens: 0, outputTokens: 0, costUsd: 0.4, known: true },
      ).known,
    ).toBe(true);
    expect(
      usageFromSdkResult(
        { total_cost_usd: 0.3, modelUsage: {} },
        { inputTokens: 10, outputTokens: 5, costUsd: 0.4, known: true },
      ),
    ).toMatchObject({ costUsd: 0.3, inputTokens: 0, outputTokens: 0, known: false });
  });

  it("does not charge a resumed session baseline before its first result", async () => {
    const fake = fakeSdk([
      { emit: msg("system", { subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" }) },
      "hang",
    ]);
    const tool = new ClaudeAgentTool({
      loadSdk: async () => fake.sdk,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
      signalPollMs: 5,
    });
    const dir = await mkdtemp(join(tmpdir(), "claude-agent-baseline-stop-"));
    const stopSignalPath = join(dir, "stop");
    try {
      const running = tool
        .run({
          ...base,
          stopSignalPath,
          resumeSessionId: "s1",
          resumeBaseline: { inputTokens: 1000, outputTokens: 500, costUsd: 0.4, known: true },
        })
        .catch((value) => value as ToolRunError);
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(stopSignalPath, "stop");
      const error = await running;
      expect(error.stopped).toBe(true);
      expect(error.usage).not.toMatchObject({ inputTokens: 1000, outputTokens: 500, costUsd: 0.4 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses assistant usage as an unknown per-turn fallback before a resumed result", async () => {
    const fake = fakeSdk([
      {
        emit: msg("assistant", {
          message: { id: "m1", usage: { input_tokens: 12, output_tokens: 4 } },
        }),
      },
      "hang",
    ]);
    const dir = await mkdtemp(join(tmpdir(), "claude-agent-assistant-usage-"));
    const stopSignalPath = join(dir, "stop");
    const tool = new ClaudeAgentTool({
      loadSdk: async () => fake.sdk,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
      signalPollMs: 5,
    });
    try {
      const running = tool.run({
        ...base,
        stopSignalPath,
        resumeSessionId: "s1",
        resumeBaseline: { inputTokens: 900, outputTokens: 500, costUsd: 0.4, known: true },
      });
      const outcome = running.catch((error) => error as ToolRunError);
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(stopSignalPath, "stop");
      const error = await outcome;
      expect(error.stopped).toBe(true);
      expect(error.usage).toMatchObject({ inputTokens: 12, outputTokens: 4, known: false });
      expect(error.usage.costUsd).not.toBe(0.4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes SDK environment additions and only the resolved credential to the child", async () => {
    const { EventEmitter } = await import("node:events");
    let childRef: any;
    const spawn = vi.fn(
      (_command: string, _args: string[], options: { env: Record<string, string> }) => {
        capturedEnv = options.env;
        const child = new EventEmitter() as any;
        childRef = child;
        child.pid = undefined;
        child.exitCode = 0;
        child.signalCode = null;
        child.kill = vi.fn();
        return child;
      },
    );
    let capturedEnv: Record<string, string> = {};
    const sdk = {
      query: ({ options, prompt }: any) => {
        options.spawnClaudeCodeProcess({
          command: "/fake",
          args: ["--sdk-protocol"],
          cwd: "/tmp",
          env: {
            ...options.env,
            CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
            CLAUDE_AGENT_SDK_VERSION: "0.3.318",
            CLAUDE_CODE_SDK_READS_SESSION_STATE: "1",
          },
          signal: options.abortController.signal,
        });
        return {
          async *[Symbol.asyncIterator]() {
            const first = await prompt[Symbol.asyncIterator]().next();
            yield msg("system", { subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" });
            yield msg("result", {
              subtype: "success",
              result: "ok",
              user_message_uuid: first.value.uuid,
            });
          },
          async close() {
            childRef.emit("close");
          },
        };
      },
    } as any;
    // The fake's SDK spawn hook is inspected without starting any executable.
    const tool = new ClaudeAgentTool({
      loadSdk: async () => sdk,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
      spawn: spawn as any,
    });
    await tool.run({ ...base, env: { ANTHROPIC_API_KEY: "fake-gateway-key" } });
    expect(capturedEnv).toMatchObject({
      ANTHROPIC_API_KEY: "fake-gateway-key",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_AGENT_SDK_VERSION: "0.3.318",
      CLAUDE_CODE_SDK_READS_SESSION_STATE: "1",
    });
    expect(capturedEnv).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(spawn).toHaveBeenCalledWith(
      "/fake",
      ["--sdk-protocol"],
      expect.objectContaining({ env: capturedEnv }),
    );
  });

  it("does not treat server environment credentials or cloud modes as authentication", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "server-secret-must-not-pass");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-must-not-pass");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
    vi.stubEnv("CLAUDE_CODE_USE_VERTEX", "1");
    vi.stubEnv("BOOF_SERVER_SECRET", "boof-secret-must-not-pass");
    try {
      const fake = fakeSdk([{ emit: msg("result", { subtype: "success", result: "ok" }) }]);
      const tool = new ClaudeAgentTool({
        loadSdk: async () => fake.sdk,
        resolveExecutable: async () => ({ path: "/fake", source: "env" }),
      });
      await tool.run({ ...base });
      const env = fake.calls.options[0].env;
      expect(env.ANTHROPIC_API_KEY).toBe("fake-gateway-key");
      expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
      expect(env).not.toHaveProperty("CLAUDE_CODE_USE_BEDROCK");
      expect(env).not.toHaveProperty("CLAUDE_CODE_USE_VERTEX");
      expect(env).not.toHaveProperty("BOOF_SERVER_SECRET");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the pid file until the spawned child closes", async () => {
    const { EventEmitter } = await import("node:events");
    const dir = await mkdtemp(join(tmpdir(), "claude-agent-pid-file-"));
    const pidFilePath = join(dir, "control", "pid");
    let childRef: any;
    const sdk = {
      query: ({ options, prompt }: any) => {
        childRef = new EventEmitter();
        Object.assign(childRef, { pid: 4242, exitCode: 0, signalCode: null, kill: vi.fn() });
        options.spawnClaudeCodeProcess({
          command: "/fake",
          args: [],
          cwd: dir,
          env: options.env,
          signal: options.abortController.signal,
        });
        return {
          async *[Symbol.asyncIterator]() {
            const first = await prompt[Symbol.asyncIterator]().next();
            yield msg("system", { subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" });
            yield msg("result", {
              subtype: "success",
              result: "ok",
              user_message_uuid: first.value.uuid,
            });
          },
          async close() {},
        };
      },
    } as any;
    const tool = new ClaudeAgentTool({
      loadSdk: async () => sdk,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
      spawn: (() => childRef) as any,
    });
    try {
      const running = tool.run({ ...base, cwd: dir, pidFilePath });
      const ready = Date.now() + 10_000;
      while (!childRef) {
        if (Date.now() > ready) throw new Error("spawn hook did not run");
        await new Promise((r) => setTimeout(r, 1));
      }
      // writePidFile fsyncs. A short poll loses to that under load, before the child closes.
      await waitForFile(pidFilePath);
      await new Promise((r) => setTimeout(r, 20));
      await access(pidFilePath);
      childRef.emit("close", 0, null);
      await running;
      await expect(access(pidFilePath)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects with the same resolver and never sends a prompt", async () => {
    const { EventEmitter } = await import("node:events");
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    const spawn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("Claude Code 2.1.test"));
        child.emit("close", 0);
      });
      return child;
    });
    const query = vi.fn();
    const tool = new ClaudeAgentTool({
      loadSdk: async () => ({ query }) as any,
      resolveExecutable: async () => ({ path: "/resolved/claude", source: "sdk" }),
      spawn: spawn as any,
    });
    vi.stubEnv("BOOF_AGENT_PROBE_TEST", "boof_fake_value");
    try {
      await expect(tool.detect()).resolves.toMatchObject({
        status: "available",
        version: "Claude Code 2.1.test",
      });
      expect(spawn).toHaveBeenCalledWith("/resolved/claude", ["--version"], expect.any(Object));
      const probeEnv = (spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }).env;
      expect(Object.keys(probeEnv).filter((name) => name.startsWith("BOOF_"))).toEqual([]);
      expect(query).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("passes only repository permission lists through settings", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "claude-agent-permissions-"));
    try {
      await mkdir(join(cwd, ".claude"));
      await writeFile(
        join(cwd, ".claude/settings.json"),
        JSON.stringify({
          permissions: {
            deny: ["Bash(git push:*)"],
            allow: ["Read(./src/**)"],
            ask: ["Write(./.env)"],
          },
          apiKeyHelper: "echo do-not-run",
          env: { ANTHROPIC_API_KEY: "ignored" },
          hooks: { PreToolUse: [] },
        }),
      );
      const fake = fakeSdk([{ emit: msg("result", { subtype: "success", result: "ok" }) }]);
      const tool = new ClaudeAgentTool({
        loadSdk: async () => fake.sdk,
        resolveExecutable: async () => ({ path: "/fake", source: "env" }),
      });
      await tool.run({ ...base, cwd });
      expect(fake.calls.options[0].settings).toEqual({
        permissions: {
          deny: ["Bash(git push:*)"],
          allow: ["Read(./src/**)"],
          ask: ["Write(./.env)"],
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not read CLAUDE.md through a symlink outside the worktree", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "claude-agent-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "claude-agent-outside-"));
    try {
      await writeFile(join(outside, "secret"), "private instructions");
      await symlink(join(outside, "secret"), join(cwd, "CLAUDE.md"));
      const fake = fakeSdk([{ emit: msg("result", { subtype: "success", result: "ok" }) }]);
      const tool = new ClaudeAgentTool({
        loadSdk: async () => fake.sdk,
        resolveExecutable: async () => ({ path: "/fake", source: "env" }),
      });
      await tool.run({ ...base, cwd });
      expect(fake.calls.options[0].systemPrompt.append).not.toContain("private instructions");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.each(["stop", "timeout", "stall", "abort"] as const)(
    "kills the full process group and retains its pid record until exit on %s",
    async (cause) => {
      const dir = await mkdtemp(join(tmpdir(), "claude-agent-process-group-"));
      const marker = join(dir, "grandchild.pid");
      const pidFilePath = join(dir, "control", "pid");
      const stopSignalPath = join(dir, "stop");
      const killAfterMs = 50;
      let wake!: () => void;
      let ended = false;
      let child: any;
      let abortRun!: () => void;
      const tool = new ClaudeAgentTool({
        resolveExecutable: async () => ({ path: "/fake", source: "env" }),
        signalPollMs: 5,
        loadSdk: async () =>
          ({
            query: ({ options }: any) => {
              abortRun = () => options.abortController.abort();
              child = options.spawnClaudeCodeProcess({
                command: process.execPath,
                args: [
                  "-e",
                  `const fs=require('node:fs'); const {spawn}=require('node:child_process'); const marker=${JSON.stringify(marker)}; const c=spawn(process.execPath,['-e','setTimeout(()=>{},300000)']); c.on('spawn',()=>{ const tmp=marker+'.tmp'; fs.writeFileSync(tmp, String(c.pid)); fs.renameSync(tmp, marker); }); setTimeout(()=>{},300000);`,
                ],
                cwd: dir,
                env: options.env,
                signal: options.abortController.signal,
              });
              options.abortController.signal.addEventListener(
                "abort",
                () => {
                  ended = true;
                  wake?.();
                },
                { once: true },
              );
              return {
                async *[Symbol.asyncIterator]() {
                  yield msg("system", { subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" });
                  while (!ended) await new Promise<void>((resolve) => (wake = resolve));
                },
                async close() {
                  ended = true;
                  wake?.();
                },
              };
            },
          }) as any,
      });
      let armKill!: () => void;
      const killArmed = new Promise<void>((resolve) => (armKill = resolve));
      const held =
        cause === "timeout" || cause === "stall"
          ? holdAgentKillTimer(killAfterMs, killArmed)
          : undefined;
      try {
        const running = tool.run({
          ...base,
          cwd: dir,
          pidFilePath,
          resumeSessionId: "prior",
          resumeBaseline: { inputTokens: 1000, outputTokens: 500, costUsd: 0.4, known: true },
          ...(cause === "stop" ? { stopSignalPath } : {}),
          ...(cause === "timeout" ? { timeoutMs: killAfterMs } : {}),
          ...(cause === "stall" ? { idleTimeoutMs: killAfterMs } : {}),
        });
        const outcome = running.then(
          () => undefined,
          (error) => error,
        );
        await waitForFile(marker);
        await waitForFile(pidFilePath);
        expect(child?.pid).toBeTruthy();
        const grandchild = Number(await readFile(marker, "utf8"));
        expect(Number.isInteger(grandchild) && grandchild > 1).toBe(true);
        const live = await procState(grandchild);
        expect(live === "" || live === "Z").toBe(false);
        if (held) {
          expect(held.pending(), held.skipped()).toBeGreaterThan(0);
          armKill();
        } else if (cause === "stop") {
          await writeFile(stopSignalPath, "stop");
        } else {
          abortRun();
        }
        const error = await outcome;
        expect(error).toMatchObject(
          cause === "stop"
            ? { stopped: true }
            : cause === "timeout"
              ? { timedOut: true }
              : cause === "stall"
                ? { stalled: true }
                : { timedOut: false, stopped: false, stalled: false },
        );
        expect(error.usage).not.toMatchObject({
          inputTokens: 1000,
          outputTokens: 500,
          costUsd: 0.4,
        });
        expect(
          await access(pidFilePath).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
        const state = await procState(grandchild);
        expect(state === "" || state === "Z").toBe(true);
      } finally {
        held?.restore();
        try {
          if (child?.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
    },
  );

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
      output: expect.stringContaining("apiKeySource=none"),
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
      env: { ANTHROPIC_API_KEY: key, CLAUDE_CONFIG_DIR: base.claudeConfigDir },
      onChunk: (s) => streamed.push(s),
    });
    expect(streamed.join("")).not.toContain(key);
    expect(result.output).not.toContain(key);
    expect(result.report).not.toContain(key);
    expect(fake.calls.options[0].env.ANTHROPIC_API_KEY).toBe(key);
    expect(fake.calls.options[0].env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });

  it("streams a now steer in place and does not finish on the interrupted result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-agent-steer-"));
    const steerSignalPath = join(dir, "steer.jsonl");
    let pushed: any;
    let promptStream: AsyncIterable<any>;
    const calls = { interrupts: 0, setModel: [] as (string | undefined)[], closed: 0 };
    const query = {
      async *[Symbol.asyncIterator]() {
        const input = promptStream[Symbol.asyncIterator]();
        yield msg("system", {
          subtype: "init",
          apiKeySource: "ANTHROPIC_API_KEY",
          session_id: "s1",
        });
        const first = await input.next();
        yield msg("result", {
          subtype: "success",
          result: "old",
          total_cost_usd: 0.8,
          modelUsage: {},
          user_message_uuids: [first.value.uuid],
        });
        const next = await input.next();
        pushed = next.value;
        yield msg("result", {
          subtype: "success",
          result: "new",
          total_cost_usd: 1.0,
          modelUsage: {},
          user_message_uuids: [pushed.uuid],
        });
      },
      async interrupt() {
        calls.interrupts++;
        return undefined;
      },
      async setModel(model?: string) {
        calls.setModel.push(model);
      },
      async streamInput(stream: AsyncIterable<any>) {
        for await (const item of stream) pushed = item;
      },
      async close() {
        calls.closed++;
      },
    };
    await writeFile(
      steerSignalPath,
      JSON.stringify({ text: "do this now", model: "sonnet" }) +
        "\n" +
        JSON.stringify({ text: "also preserve this", model: "opus" }) +
        "\n",
    );
    const tool = new ClaudeAgentTool({
      loadSdk: async () =>
        ({
          query: ({ prompt }: { prompt: AsyncIterable<any> }) => {
            promptStream = prompt;
            return query;
          },
        }) as any,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
      signalPollMs: 5,
    });
    try {
      const result = await tool.run({
        ...base,
        steerSignalPath,
        resumeBaseline: { inputTokens: 0, outputTokens: 0, costUsd: 0.4, known: true },
        onSteer: async () => {
          await rm(steerSignalPath, { force: true });
          return { texts: ["do this now", "also preserve this"], model: "opus", last: false };
        },
      });
      expect(calls.interrupts).toBe(1);
      expect(calls.setModel).toEqual(["opus"]);
      expect(pushed.message.content).toContain("do this now");
      expect(pushed.message.content).toContain("also preserve this");
      expect(result.report).toBe("new");
      expect(result.usage?.costUsd).toBeCloseTo(0.6);
      expect(calls.closed).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not accept an SDK result without message uuids as the final answer", async () => {
    const sdk = {
      query: () => ({
        async *[Symbol.asyncIterator]() {
          yield msg("result", { subtype: "success", result: "unattributed" });
        },
        async close() {},
      }),
    } as any;
    const tool = new ClaudeAgentTool({
      loadSdk: async () => sdk,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
    });
    await expect(tool.run(base)).rejects.toBeInstanceOf(ToolRunError);
  });

  it("delivers a steer taken at the turn boundary before accepting the result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-agent-steer-boundary-"));
    const steerSignalPath = join(dir, "steer.jsonl");
    let promptStream!: AsyncIterable<any>;
    let pushed: any;
    let resolveTaken!: () => void;
    const taken = new Promise<void>((resolve) => (resolveTaken = resolve));
    const query = {
      async *[Symbol.asyncIterator]() {
        const input = promptStream[Symbol.asyncIterator]();
        yield msg("system", { subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" });
        const first = await input.next();
        await taken;
        yield msg("result", {
          subtype: "success",
          result: "answer to original",
          user_message_uuids: [first.value.uuid],
        });
        pushed = (await input.next()).value;
        yield msg("result", {
          subtype: "success",
          result: "answer to steer",
          user_message_uuids: [pushed.uuid],
        });
      },
      async interrupt() {},
      async setModel() {},
      async close() {},
    };
    await writeFile(steerSignalPath, JSON.stringify({ text: "new instruction" }) + "\n");
    const tool = new ClaudeAgentTool({
      loadSdk: async () =>
        ({
          query: ({ prompt }: { prompt: AsyncIterable<any> }) => {
            promptStream = prompt;
            return query;
          },
        }) as any,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
      signalPollMs: 2,
    });
    try {
      const result = await tool.run({
        ...base,
        steerSignalPath,
        onSteer: async () => {
          await rm(steerSignalPath, { force: true });
          resolveTaken();
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { texts: ["new instruction"], last: false };
        },
      });
      expect(result.report).toBe("answer to steer");
      expect(pushed.message.content).toContain("new instruction");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resets the SDK model when a steer selects default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-agent-model-"));
    const steerSignalPath = join(dir, "steer.jsonl");
    let pushed: any;
    const setModel: (string | undefined)[] = [];
    let promptStream!: AsyncIterable<any>;
    const query = {
      async *[Symbol.asyncIterator]() {
        const input = promptStream[Symbol.asyncIterator]();
        yield msg("system", { subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" });
        await input.next();
        const next = await input.next();
        pushed = next.value;
        yield msg("result", {
          subtype: "success",
          result: "done",
          user_message_uuids: [pushed.uuid],
        });
      },
      async interrupt() {},
      async setModel(model?: string) {
        setModel.push(model);
      },
      async close() {},
    };
    await writeFile(steerSignalPath, JSON.stringify({ text: "continue", model: "default" }) + "\n");
    const tool = new ClaudeAgentTool({
      loadSdk: async () =>
        ({
          query: ({ prompt }: { prompt: AsyncIterable<any> }) => {
            promptStream = prompt;
            return query;
          },
        }) as any,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
      signalPollMs: 5,
    });
    try {
      await tool.run({
        ...base,
        steerSignalPath,
        onSteer: async () => {
          await rm(steerSignalPath, { force: true });
          return { texts: ["continue"], model: "default", last: false };
        },
      });
      expect(setModel).toEqual([undefined]);
      expect(pushed.message.content).toContain("continue");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves a steer pending and falls back when interrupt rejects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-agent-interrupt-fail-"));
    const steerSignalPath = join(dir, "steer.jsonl");
    await writeFile(steerSignalPath, JSON.stringify({ text: "retry this" }) + "\n");
    const fake = fakeSdk([
      {
        emit: msg("system", {
          subtype: "init",
          apiKeySource: "ANTHROPIC_API_KEY",
          session_id: "s1",
        }),
      },
      "hang",
      { interruptResult: new Error("interrupt failed") },
    ]);
    const onSteer = vi.fn(async () => ({ texts: ["retry this"], last: false }));
    const tool = new ClaudeAgentTool({
      loadSdk: async () => fake.sdk,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
      signalPollMs: 5,
    });
    try {
      await expect(tool.run({ ...base, steerSignalPath, onSteer })).rejects.toMatchObject({
        steered: true,
      });
      expect(onSteer).not.toHaveBeenCalled();
      expect(fake.calls.interrupts).toBe(1);
      expect(fake.calls.closed).toBe(1);
      await expect(
        import("node:fs/promises").then(({ access }) => access(steerSignalPath)),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lets stop win when stop and steer files appear together", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-agent-stop-steer-"));
    const steerSignalPath = join(dir, "steer.jsonl");
    const stopSignalPath = join(dir, "stop");
    await writeFile(steerSignalPath, JSON.stringify({ text: "steer" }) + "\n");
    await writeFile(stopSignalPath, "stop\n");
    const fake = fakeSdk([
      { emit: msg("system", { subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" }) },
      "hang",
    ]);
    const onSteer = vi.fn(async () => ({ texts: ["steer"], last: false }));
    const tool = new ClaudeAgentTool({
      loadSdk: async () => fake.sdk,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
      signalPollMs: 5,
    });
    try {
      await expect(
        tool.run({ ...base, steerSignalPath, stopSignalPath, onSteer }),
      ).rejects.toMatchObject({
        stopped: true,
      });
      expect(onSteer).not.toHaveBeenCalled();
      expect(fake.calls.interrupts).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const WIN_ROOT = "2026-11-02T17:30:07.1234560Z";
  const WIN_CHILD = "2026-11-02T17:30:09.0000000Z";
  const WIN_OLD = "2026-11-02T08:00:00.0000000Z";

  async function windowsStop(
    table: () => Promise<{
      rows: { pid: number; ppid: number; created: string }[];
      droppedNonIso: number;
      unparsed: number;
    } | null>,
  ) {
    const { EventEmitter } = await import("node:events");
    const dir = await mkdtemp(join(tmpdir(), "claude-agent-win-kill-"));
    const stopSignalPath = join(dir, "stop");
    const killed: { pid: number }[][] = [];
    let tableCalls = 0;
    let childRef: EventEmitter & {
      pid: number;
      kill: ReturnType<typeof vi.fn>;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as typeof childRef;
      childRef = child;
      child.pid = 424242;
      child.exitCode = null;
      child.signalCode = null;
      // signalCode is set when kill is asked, but `close` waits a turn. The abort listener and
      // the poll callback both enter the stop in one turn, before that close, which is when a
      // second pid kill used to slip through. The second call must not walk the tree.
      child.kill = vi.fn(() => {
        child.signalCode = "SIGTERM";
        setTimeout(() => child.emit("close", null, "SIGTERM"), 0);
        return true;
      });
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.emit("close", 1, null);
      }, 500);
      return child;
    });
    const sdk = {
      query: ({ options, prompt }: any) => {
        options.spawnClaudeCodeProcess({
          command: "claude",
          args: ["--sdk-protocol"],
          cwd: dir,
          env: options.env,
          signal: options.abortController.signal,
        });
        let ended = false;
        let wake: () => void = () => {};
        const finish = () => {
          ended = true;
          wake();
        };
        options.abortController.signal.addEventListener("abort", finish, { once: true });
        return {
          async *[Symbol.asyncIterator]() {
            const first = await prompt[Symbol.asyncIterator]().next();
            yield msg("system", { subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" });
            while (!ended) await new Promise<void>((resolve) => (wake = resolve));
            yield msg("result", {
              subtype: "success",
              result: "stopped",
              user_message_uuid: first.value.uuid,
            });
          },
          async close() {
            finish();
          },
        };
      },
    };
    const tool = new ClaudeAgentTool({
      loadSdk: async () => sdk as never,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
      spawn: spawn as never,
      signalPollMs: 5,
      platform: "win32",
      windowsStop: {
        table: async () => {
          tableCalls += 1;
          return table();
        },
        killList: async (list) => {
          killed.push(list.map((item) => ({ pid: item.pid })));
          return true;
        },
      },
    });
    try {
      const running = tool.run({ ...base, cwd: dir, stopSignalPath });
      const outcome = running.then(
        () => undefined,
        (err) => err as { stopped?: boolean },
      );
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(stopSignalPath, "stop");
      const error = await outcome;
      return { error, spawn, killed, tableCalls, child: childRef! };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("on Windows a stop kills verified children and the root handle, once", async () => {
    const { error, spawn, killed, tableCalls, child } = await windowsStop(async () => ({
      rows: [
        { pid: 424242, ppid: 1, created: WIN_ROOT },
        { pid: 5000, ppid: 424242, created: WIN_CHILD },
        { pid: 6000, ppid: 424242, created: WIN_OLD },
      ],
      droppedNonIso: 0,
      unparsed: 0,
    }));
    expect(error?.stopped).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "claude",
      ["--sdk-protocol"],
      expect.objectContaining({ windowsHide: true, detached: false }),
    );
    // Abort and the poll both call the stop before exitCode is set. One walk, not two.
    expect(tableCalls).toBe(1);
    expect(killed).toEqual([[{ pid: 5000 }]]);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("on Windows a process table that cannot be read kills only the root handle", async () => {
    const { error, killed, tableCalls, child } = await windowsStop(async () => null);
    expect(error?.stopped).toBe(true);
    expect(tableCalls).toBe(1);
    expect(killed).toEqual([]);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("stops watching once the in-place steer limit is reached", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-agent-steer-limit-"));
    const steerSignalPath = join(dir, "steer.jsonl");
    let pushed: any;
    let promptStream!: AsyncIterable<any>;
    const fakeQuery = {
      async *[Symbol.asyncIterator]() {
        const input = promptStream[Symbol.asyncIterator]();
        yield msg("system", { subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" });
        await input.next();
        pushed = (await input.next()).value;
        yield msg("result", {
          subtype: "success",
          result: "done",
          user_message_uuids: [pushed.uuid],
        });
      },
      async interrupt() {},
      async setModel() {},
      async close() {},
    };
    await writeFile(steerSignalPath, JSON.stringify({ text: "fifth" }) + "\n");
    const onSteer = vi.fn(async () => {
      await rm(steerSignalPath, { force: true });
      await writeFile(steerSignalPath, JSON.stringify({ text: "sixth" }) + "\n");
      return { texts: ["fifth"], last: true };
    });
    const tool = new ClaudeAgentTool({
      loadSdk: async () =>
        ({
          query: ({ prompt }: { prompt: AsyncIterable<any> }) => {
            promptStream = prompt;
            return fakeQuery;
          },
        }) as any,
      resolveExecutable: async () => ({ path: "/fake", source: "env" }),
      signalPollMs: 5,
    });
    try {
      await tool.run({ ...base, steerSignalPath, onSteer });
      expect(onSteer).toHaveBeenCalledTimes(1);
      expect(pushed.message.content).toContain("fifth");
      await expect(
        import("node:fs/promises").then(({ access }) => access(steerSignalPath)),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
