import type { TokenUsage } from "@boof/heart";
import { writePidFile } from "@boof/heart";
import { redactSecrets } from "@boof/owlish";
import { spawn as nodeSpawn } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Options as SdkOptions, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentAuthRefusedError, claudeAgentEnv } from "../agent-auth.js";
import { agentEnv } from "../agent-env.js";
import { StreamRenderer } from "./claude-code.js";
import { ToolRunError } from "./errors.js";
import { withQuestions } from "./questions.js";
import { RESUME_PROMPT_PREFIX } from "../pipeline.js";
import type { DetectOptions, HealthResult, RunOptions, RunResult, Tool } from "./types.js";
import {
  loadAgentSdk,
  resolveClaudeAgentExecutable,
  SDK_VERSION,
  type AgentSdk,
} from "./claude-agent-sdk.js";

type Spawn = typeof nodeSpawn;
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = [];
  private waiters: (() => void)[] = [];
  private ended = false;
  push(text: string, opts: { uuid?: string; priority?: "now" | "next" } = {}): string {
    const uuid = opts.uuid ?? crypto.randomUUID();
    this.values.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
      uuid,
      ...(opts.priority ? { priority: opts.priority } : {}),
    } as SDKUserMessage);
    this.waiters.splice(0).forEach((wake) => wake());
    return uuid;
  }
  end(): void {
    this.ended = true;
    this.waiters.splice(0).forEach((wake) => wake());
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this.ended || this.values.length) {
      if (!this.values.length) await new Promise<void>((resolve) => this.waiters.push(resolve));
      while (this.values.length) yield this.values.shift()!;
    }
  }
}

export function usageFromSdkResult(
  r: { total_cost_usd?: unknown; modelUsage?: unknown },
  baseline?: TokenUsage,
): TokenUsage {
  const models =
    r.modelUsage && typeof r.modelUsage === "object"
      ? Object.values(r.modelUsage as Record<string, Record<string, unknown>>)
      : [];
  const nums = (key: string) =>
    models.reduce(
      (n, v) =>
        n + (typeof v[key] === "number" && Number.isFinite(v[key]) ? (v[key] as number) : 0),
      0,
    );
  let inputTokens =
    nums("inputTokens") + nums("cacheReadInputTokens") + nums("cacheCreationInputTokens");
  let outputTokens = nums("outputTokens");
  let costUsd =
    typeof r.total_cost_usd === "number" && Number.isFinite(r.total_cost_usd)
      ? r.total_cost_usd
      : 0;
  const known =
    typeof r.total_cost_usd === "number" &&
    Number.isFinite(r.total_cost_usd) &&
    !models.some((v) => v.costBasis === "unknown");
  if (
    baseline &&
    inputTokens >= baseline.inputTokens &&
    outputTokens >= baseline.outputTokens &&
    costUsd >= baseline.costUsd
  ) {
    inputTokens -= baseline.inputTokens;
    outputTokens -= baseline.outputTokens;
    costUsd -= baseline.costUsd;
  }
  return { inputTokens, outputTokens, costUsd, known: known && (baseline?.known ?? true) };
}

export interface ClaudeAgentToolOptions {
  loadSdk?: () => Promise<AgentSdk>;
  resolveExecutable?: typeof resolveClaudeAgentExecutable;
  spawn?: Spawn;
  clientApp?: string;
  signalPollMs?: number;
  unavailableReason?: string;
}

export class ClaudeAgentTool implements Tool {
  readonly id = "claude-agent";
  readonly displayName = "Claude Agent SDK";
  readonly defaultModels = ["default"];
  readonly supportsResume = true;
  readonly acceptsPool = false;
  readonly needsAgentAuth = true;
  readonly steersInPlace = true;
  readonly unavailableReason?: string;
  private readonly loadSdk: () => Promise<AgentSdk>;
  private readonly resolveExecutable: typeof resolveClaudeAgentExecutable;
  private readonly spawn: Spawn;
  private readonly clientApp: string;
  private readonly signalPollMs: number;

  constructor(options: ClaudeAgentToolOptions = {}) {
    this.unavailableReason = options.unavailableReason;
    this.loadSdk = options.loadSdk ?? loadAgentSdk;
    this.resolveExecutable = options.resolveExecutable ?? resolveClaudeAgentExecutable;
    this.spawn = options.spawn ?? nodeSpawn;
    this.clientApp = options.clientApp ?? `boof-runner/${SDK_VERSION}`;
    this.signalPollMs = options.signalPollMs ?? 500;
  }

  async listModels(): Promise<string[]> {
    return ["default", "opus", "sonnet", "haiku"];
  }
  async detect(_opts: DetectOptions = {}): Promise<HealthResult> {
    if (this.unavailableReason) return { status: "unavailable", message: this.unavailableReason };
    try {
      await this.loadSdk();
    } catch (e) {
      return { status: "unavailable", message: (e as Error).message };
    }
    const exe = await this.resolveExecutable();
    if (exe.source === null)
      return {
        status: "unavailable",
        message:
          exe.reason ??
          "Claude Code native binary not found (set BOOF_RUNNER_CLAUDE_AGENT_BIN or install claude)",
      };
    const path = exe.path ?? (await bundledExecutable());
    if (!path)
      return {
        status: "unavailable",
        message:
          "Claude Code native binary not found (set BOOF_RUNNER_CLAUDE_AGENT_BIN or install claude)",
      };
    return new Promise((resolve) => {
      let out = "";
      const child = this.spawn(path, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 8000,
      });
      child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      child.on("error", () =>
        resolve({ status: "unavailable", message: "Claude Code --version failed" }),
      );
      child.on("close", (code) =>
        resolve(
          code === 0
            ? {
                status: "available",
                message: `Agent SDK ${SDK_VERSION}, Claude Code ${out.trim()}; authentication is decided per project when a task starts`,
                version: out.trim(),
              }
            : {
                status: "unavailable",
                message: `Claude Code --version failed (exit ${code ?? "null"})`,
              },
        ),
      );
    });
  }

  async run(opts: RunOptions): Promise<RunResult> {
    if (this.unavailableReason) throw new AgentAuthRefusedError(this.unavailableReason);
    const auth = opts.agentAuth;
    if (!auth)
      throw new AgentAuthRefusedError("claude-agent cannot start: no authentication decision");
    if (!opts.claudeConfigDir)
      throw new AgentAuthRefusedError(
        "claude-agent cannot start: the per-project Claude config directory is unavailable",
      );
    const secrets = auth.apiKey ? [auth.apiKey] : [];
    const scrub = (s: string) => redactSecrets(s, secrets);
    const sdk = await this.loadSdk();
    const executable = await this.resolveExecutable();
    if (!executable.path && executable.source !== "sdk")
      throw new AgentAuthRefusedError(
        "Claude Code native binary not found (set BOOF_RUNNER_CLAUDE_AGENT_BIN or install claude)",
      );
    const abortController = new AbortController();
    const queue = new InputQueue();
    const uuid = queue.push(opts.prompt);
    const env = claudeAgentEnv(
      agentEnv(process.env, opts.agentEnv),
      auth,
      this.clientApp,
      opts.claudeConfigDir,
    );
    const claudeMd = await readFile(`${opts.cwd}/CLAUDE.md`, "utf8")
      .then((text) => text.slice(0, 64 * 1024))
      .catch(() => "");
    const childEnv = { ...env };
    const queryOptions: SdkOptions = {
      cwd: opts.cwd,
      ...(opts.model && opts.model !== "default" && opts.model !== "" ? { model: opts.model } : {}),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: `${opts.systemPrompt}${claudeMd ? `\n\n## Repository instructions (CLAUDE.md)\n${claudeMd}` : ""}`,
      },
      strictMcpConfig: !opts.inheritMcpServers,
      ...(opts.autoApprove
        ? { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }
        : { permissionMode: "default", permissionPrompts: "none" }),
      settingSources: [],
      extraArgs: { bare: null },
      resume: opts.resumeSessionId,
      includePartialMessages: true,
      env: childEnv,
      pathToClaudeCodeExecutable: executable.path,
      abortController,
      stderr: (data) => {
        stderr += data;
      },
      spawnClaudeCodeProcess: (o) => {
        const command = executable.path ?? o.command;
        const child = this.spawn(command, o.args, {
          cwd: opts.cwd,
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
        if (opts.pidFilePath && child.pid)
          void writePidFile(opts.pidFilePath, { pgid: child.pid, command: "claude" });
        return child as never;
      },
    };
    let stderr = "";
    const query = sdk.query({ prompt: queue, options: queryOptions });
    let queryClosed = false;
    const closeQuery = () => {
      if (!queryClosed) {
        queryClosed = true;
        query.close();
      }
    };
    const renderer = new StreamRenderer((text) => opts.onChunk?.(scrub(text)));
    let sessionId: string | undefined;
    let lastUsage: TokenUsage | undefined;
    let result: Record<string, unknown> | undefined;
    let latestUuid = uuid;
    let steerPending = false;
    let steerFailure: ToolRunError | undefined;
    let lastSteer = false;
    let timedOut = false,
      stopped = false,
      stalled = false;
    const deadline = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          abortController.abort();
          closeQuery();
        }, opts.timeoutMs)
      : undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (opts.idleTimeoutMs)
        idleTimer = setTimeout(() => {
          stalled = true;
          abortController.abort();
          closeQuery();
        }, opts.idleTimeoutMs);
    };
    resetIdle();
    const poll = setInterval(async () => {
      if (stopped || timedOut || stalled || steerPending) return;
      if (opts.stopSignalPath) {
        try {
          await access(opts.stopSignalPath);
          stopped = true;
          abortController.abort();
          closeQuery();
          return;
        } catch {
          /* absent */
        }
      }
      if (!opts.steerSignalPath || !opts.onSteer || lastSteer) return;
      steerPending = true;
      try {
        await access(opts.steerSignalPath);
      } catch {
        steerPending = false;
        return;
      }
      if (opts.stopSignalPath) {
        try {
          await access(opts.stopSignalPath);
          stopped = true;
          abortController.abort();
          closeQuery();
          steerPending = false;
          return;
        } catch {
          /* no stop */
        }
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          query.interrupt(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("interrupt timed out")), 10_000);
          }),
        ]);
      } catch {
        closeQuery();
        steerFailure = new ToolRunError(
          this.id,
          1,
          false,
          false,
          scrub(renderer.transcript),
          scrub(stderr),
          false,
          0,
          { steered: true, sessionId, usage: lastUsage },
        );
        return;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      try {
        const request = await opts.onSteer();
        if (request.model !== undefined)
          await query.setModel(request.model === "default" ? undefined : request.model);
        latestUuid = queue.push(
          request.texts.length
            ? RESUME_PROMPT_PREFIX + request.texts.join("\n\n")
            : "Continue the same task from where you stopped.",
        );
        lastSteer = request.last;
      } catch (error) {
        steerFailure =
          error instanceof ToolRunError
            ? error
            : new ToolRunError(
                this.id,
                1,
                false,
                false,
                scrub(String(error)),
                scrub(stderr),
                false,
                0,
                { sessionId, usage: lastUsage },
              );
        closeQuery();
      } finally {
        steerPending = false;
      }
    }, this.signalPollMs);
    let forceClose: ReturnType<typeof setTimeout> | undefined;
    try {
      for await (const message of query) {
        resetIdle();
        const m = (message ?? {}) as unknown as Record<string, unknown>;
        renderer.push(JSON.stringify(message) + "\n");
        if (typeof m.session_id === "string") sessionId = m.session_id;
        if (m.type === "system" && m.subtype === "init" && m.apiKeySource !== "ANTHROPIC_API_KEY") {
          closeQuery();
          throw new ToolRunError(
            this.id,
            1,
            false,
            false,
            "claude-agent refused: the session did not authenticate with an explicit ANTHROPIC_API_KEY",
            "",
            false,
            0,
            { sessionId },
          );
        }
        if (m.type === "result") {
          lastUsage = usageFromSdkResult(m, opts.resumeBaseline);
          const answered = Array.isArray(m.user_message_uuids)
            ? m.user_message_uuids
            : typeof m.user_message_uuid === "string"
              ? [m.user_message_uuid]
              : undefined;
          if (answered?.includes(latestUuid)) {
            if (opts.stopSignalPath) {
              try {
                await access(opts.stopSignalPath);
                stopped = true;
                abortController.abort();
                closeQuery();
                continue;
              } catch {
                /* no stop */
              }
            }
            if (opts.steerSignalPath && opts.onSteer && !lastSteer) {
              try {
                await access(opts.steerSignalPath);
                continue;
              } catch {
                /* no pending steer */
              }
            }
          }
          if (answered ? answered.includes(latestUuid) : true) {
            result = m;
            queue.end();
            forceClose = setTimeout(closeQuery, 5000);
          }
        }
      }
      if (steerFailure) throw steerFailure;
    } catch (error) {
      if (error instanceof ToolRunError) throw error;
      throw new ToolRunError(
        this.id,
        1,
        false,
        false,
        scrub(`${renderer.transcript}\n${String(error)}`),
        scrub(stderr),
        false,
        0,
        { sessionId, usage: lastUsage },
      );
    } finally {
      clearInterval(poll);
      if (deadline) clearTimeout(deadline);
      if (idleTimer) clearTimeout(idleTimer);
      if (forceClose) clearTimeout(forceClose);
      queue.end();
      closeQuery();
      if (opts.pidFilePath) await rm(opts.pidFilePath, { force: true }).catch(() => {});
    }
    renderer.flush();
    const output = scrub(
      `$ claude-agent (Agent SDK ${SDK_VERSION}) --model ${opts.model} [auth: ${auth.kind === "gateway" ? "better-ccflare gateway" : "project API key"}]\n${renderer.transcript}`,
    );
    const errors = Array.isArray(result?.errors) ? result!.errors.map(String).join("\n") : "";
    if (
      !result ||
      timedOut ||
      stopped ||
      stalled ||
      result?.is_error ||
      (result?.subtype && result.subtype !== "success")
    )
      throw new ToolRunError(
        this.id,
        timedOut ? null : 1,
        timedOut,
        stopped,
        scrub(`${output}\n${errors}`),
        scrub(stderr),
        stalled,
        opts.idleTimeoutMs,
        { sessionId, usage: lastUsage },
      );
    return withQuestions({
      output,
      report: scrub(
        typeof result?.result === "string" ? result.result : renderer.transcript.trim(),
      ),
      usage: lastUsage ?? usageFromSdkResult({}),
      sessionId,
    });
  }
}

async function bundledExecutable(): Promise<string | undefined> {
  try {
    const require = createRequire(import.meta.url);
    const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const sdkRequire = createRequire(sdkEntry);
    const report = process.report?.getReport() as
      { header?: { glibcVersionRuntime?: string } } | undefined;
    const variant =
      process.platform === "linux" && !report?.header?.glibcVersionRuntime ? "-musl" : "";
    const packageName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${variant}`;
    return sdkRequire.resolve(
      `${packageName}/${process.platform === "win32" ? "claude.exe" : "claude"}`,
    );
  } catch {
    return undefined;
  }
}
