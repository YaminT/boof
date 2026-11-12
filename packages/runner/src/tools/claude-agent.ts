import type { TokenUsage } from "@boof/heart";
import {
  SandboxUnavailableError,
  killGroup,
  killWindowsProcessTree,
  sandboxApplier,
  writePidFile,
  type WindowsTreeKillDeps,
} from "@boof/heart";
import { redactSecrets } from "@boof/owlish";
import { spawn as nodeSpawn } from "node:child_process";
import { access, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Options as SdkOptions, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentAuthRefusedError } from "../agent-auth.js";
import { agentEnv } from "../agent-env.js";
import { StreamRenderer } from "./claude-code.js";
import { ToolRunError } from "./errors.js";
import { withQuestions } from "./questions.js";
import { RESUME_PROMPT_PREFIX } from "./steer.js";
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
  let deltaApplied = false;
  if (
    baseline &&
    inputTokens >= baseline.inputTokens &&
    outputTokens >= baseline.outputTokens &&
    costUsd >= baseline.costUsd
  ) {
    inputTokens -= baseline.inputTokens;
    outputTokens -= baseline.outputTokens;
    costUsd -= baseline.costUsd;
    deltaApplied = true;
  }
  // A resumed SDK process may restart cumulative totals. In that case these remain
  // the attempt's own totals; valid cumulative deltas remain known.
  return { inputTokens, outputTokens, costUsd, known: known && (!baseline || deltaApplied) };
}

/**
 * Redacts a streamed string, holding back a suffix so a secret split across chunks is not emitted
 * until it can be replaced whole.
 */
export function createStreamRedactor(
  secrets: readonly string[],
  emit: (text: string) => void,
): { push(text: string): void; flush(): void } {
  let streamCarry = "";
  const scrub = (text: string) => redactSecrets(text, secrets);
  const maxSecretLength = Math.max(0, ...secrets.map((secret) => secret.length));
  return {
    push(text: string) {
      streamCarry += text;
      let cutoff = Math.max(0, streamCarry.length - maxSecretLength);
      for (const secret of secrets) {
        let from = 0;
        while (secret.length && (from = streamCarry.indexOf(secret, from)) !== -1) {
          const end = from + secret.length;
          if (from < cutoff && end > cutoff) cutoff = from;
          from = end;
        }
      }
      if (cutoff > 0) {
        const safe = scrub(streamCarry.slice(0, cutoff));
        streamCarry = streamCarry.slice(cutoff);
        if (safe) emit(safe);
      }
    },
    flush() {
      const safe = scrub(streamCarry);
      streamCarry = "";
      if (safe) emit(safe);
    },
  };
}

export interface ClaudeAgentToolOptions {
  loadSdk?: () => Promise<AgentSdk>;
  resolveExecutable?: typeof resolveClaudeAgentExecutable;
  spawn?: Spawn;
  signalPollMs?: number;
  unavailableReason?: string;
  /** Tests inject a platform. Production uses `process.platform`. */
  platform?: NodeJS.Platform;
  /**
   * Live Windows stop: verified children, then the root handle. Tests inject the table and the
   * child kill. Production uses {@link killWindowsProcessTree}. Never `taskkill /T`.
   */
  windowsStop?: WindowsTreeKillDeps;
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
  private readonly signalPollMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly windowsStop: WindowsTreeKillDeps | undefined;

  constructor(options: ClaudeAgentToolOptions = {}) {
    this.unavailableReason = options.unavailableReason;
    this.loadSdk = options.loadSdk ?? loadAgentSdk;
    this.resolveExecutable = options.resolveExecutable ?? resolveClaudeAgentExecutable;
    this.spawn = options.spawn ?? nodeSpawn;
    this.signalPollMs = options.signalPollMs ?? 500;
    this.platform = options.platform ?? process.platform;
    this.windowsStop = options.windowsStop;
  }

  async listModels(): Promise<string[]> {
    return ["default", "opus", "sonnet", "haiku"];
  }
  /** Selection-time availability check; it never starts Claude Code or sends a prompt. */
  async checkAvailableForSelection(): Promise<string | null> {
    if (this.unavailableReason) return this.unavailableReason;
    try {
      await this.loadSdk();
    } catch (error) {
      return (error as Error).message;
    }
    const executable = await this.resolveExecutable();
    if (!executable.path && executable.source !== "sdk")
      return (
        executable.reason ??
        "Claude Code native binary not found (set BOOF_RUNNER_CLAUDE_AGENT_BIN or install claude)"
      );
    return null;
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
    const path = exe.path;
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
        env: agentEnv(),
        windowsHide: true,
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
    if (!opts.env)
      throw new AgentAuthRefusedError(
        "claude-agent cannot start: explicit child environment is missing",
      );
    const env = opts.env;
    const claudeMd = await readRepoFile(opts.cwd, "CLAUDE.md");
    const permissions = await readRepoPermissions(opts.cwd);
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
      // Project hooks and plugins remain unsupported in claude-agent; only Claude permission rules are copied below.
      ...(permissions ? { settings: { permissions } } : {}),
      resume: opts.resumeSessionId,
      includePartialMessages: true,
      env: childEnv,
      pathToClaudeCodeExecutable: executable.path,
      abortController,
      stderr: (data) => {
        stderr += data;
      },
      spawnClaudeCodeProcess: (o) => {
        let child: ReturnType<Spawn>;
        if (opts.launch?.kind === "sandbox") {
          const apply = sandboxApplier();
          if (!apply) throw new SandboxUnavailableError("no sandbox backend is registered");
          const plan = apply(
            opts.launch,
            o.command,
            o.args,
            (o.env as NodeJS.ProcessEnv | undefined) ?? childEnv,
          );
          child = this.spawn(plan.command, plan.args, {
            cwd: o.cwd ?? opts.cwd,
            env: plan.env,
            stdio: ["pipe", "pipe", "pipe", "pipe"],
            detached: this.platform !== "win32",
            windowsHide: true,
          });
          try {
            plan.deliver(child);
          } catch (err) {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
            throw err;
          }
        } else {
          child = this.spawn(o.command, o.args, {
            cwd: o.cwd ?? opts.cwd,
            env: o.env ?? childEnv,
            stdio: ["pipe", "pipe", "pipe"],
            detached: this.platform !== "win32",
            windowsHide: true,
          });
        }
        if (opts.pidFilePath && child.pid)
          pidWritten = writePidFile(opts.pidFilePath, { pgid: child.pid, command: "claude" }).catch(
            () => {},
          );
        childClosed = new Promise((resolveClosed) =>
          child.once("close", () => {
            void (async () => {
              await pidWritten;
              if (groupKill) await groupKill;
              if (opts.pidFilePath) await rm(opts.pidFilePath, { force: true }).catch(() => {});
              resolveClosed();
            })();
          }),
        );
        const forwardAbort = () => {
          void killChildGroup();
        };
        o.signal?.addEventListener("abort", forwardAbort, { once: true });
        child.once("close", () => o.signal?.removeEventListener("abort", forwardAbort));
        spawnedChild = child;
        return child as never;
      },
    };
    let stderr = "";
    let spawnedChild: ReturnType<Spawn> | undefined;
    let pidWritten: Promise<void> = Promise.resolve();
    let groupKill: Promise<unknown> | undefined;
    let childClosed: Promise<void> | undefined;
    // One Windows tree walk per child. A second stop (abort, then the poll, then `finally`)
    // waits for that walk and only then kills the handle, so the snapshot still contains the
    // root and its children. Killing now would drop the root before PowerShell has enumerated.
    // The walk is bounded, so a probe that never returns still stops the handle and `finally`
    // does not wait forever. Once `exitCode` or `signalCode` is set the handle is closed and
    // the pid may belong to someone else: nothing is signalled, and the walk ignores that row.
    let windowsLatched = false;
    let windowsWalk: Promise<void> | undefined;
    const killChildGroup = () => {
      const pid = spawnedChild?.pid;
      if (this.platform === "win32") {
        const child = spawnedChild;
        if (!child) return Promise.resolve();
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
        const killRoot = () => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          try {
            child.kill("SIGTERM");
          } catch {
            /* already exited */
          }
        };
        if (windowsLatched) return (windowsWalk ?? Promise.resolve()).then(killRoot);
        windowsLatched = true;
        const pending = killWindowsProcessTree(pid, killRoot, {
          ...this.windowsStop,
          rootStillOurs: () => child.exitCode === null && child.signalCode === null,
        }).catch(() => {});
        windowsWalk = pending;
        groupKill = pending;
        return pending;
      }
      if (!pid) {
        try {
          spawnedChild?.kill("SIGTERM");
        } catch {
          /* already exited */
        }
        return Promise.resolve();
      }
      return (groupKill ??= killGroup(pid, { termWaitMs: 1500, killWaitMs: 1000 }));
    };
    const query = sdk.query({ prompt: queue, options: queryOptions });
    let queryClosed = false;
    const closeQuery = () => {
      if (!queryClosed) {
        queryClosed = true;
        query.close();
      }
    };
    const redactor = createStreamRedactor(secrets, (text) => opts.onChunk?.(text));
    const renderer = new StreamRenderer((text) => redactor.push(text));
    let sessionId: string | undefined;
    let lastUsage: TokenUsage | undefined;
    let result: Record<string, unknown> | undefined;
    let latestUuid = uuid;
    let steerPending = false;
    let finalResultSeen = false;
    let boundarySteerPending = false;
    let polling = false;
    let steerInFlight = false;
    let resultsSincePush = 0;
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
          void killChildGroup();
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
          void killChildGroup();
        }, opts.idleTimeoutMs);
    };
    resetIdle();
    const poll = setInterval(async () => {
      if (
        polling ||
        stopped ||
        timedOut ||
        stalled ||
        result ||
        (finalResultSeen && !boundarySteerPending) ||
        steerPending
      )
        return;
      polling = true;
      try {
        if (opts.stopSignalPath) {
          try {
            await access(opts.stopSignalPath);
            stopped = true;
            abortController.abort();
            closeQuery();
            void killChildGroup();
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
            void killChildGroup();
            steerPending = false;
            return;
          } catch {
            /* no stop */
          }
        }
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          if (result || (finalResultSeen && !boundarySteerPending)) {
            steerPending = false;
            return;
          }
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
            { steered: true, sessionId, usage: lastUsage ?? assistantUsage(renderer.usage) },
          );
          return;
        } finally {
          if (timeout) clearTimeout(timeout);
        }
        if (result || (finalResultSeen && !boundarySteerPending)) {
          steerPending = false;
          return;
        }
        try {
          steerInFlight = true;
          const request = await opts.onSteer();
          if (request.model !== undefined)
            await query.setModel(request.model === "default" ? undefined : request.model);
          latestUuid = queue.push(
            request.texts.length
              ? RESUME_PROMPT_PREFIX + request.texts.join("\n\n")
              : "Continue the same task from where you stopped.",
          );
          resultsSincePush = 0;
          finalResultSeen = false;
          boundarySteerPending = false;
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
                  { sessionId, usage: lastUsage ?? assistantUsage(renderer.usage) },
                );
          closeQuery();
        } finally {
          steerInFlight = false;
          steerPending = false;
        }
      } finally {
        polling = false;
      }
    }, this.signalPollMs);
    let forceClose: ReturnType<typeof setTimeout> | undefined;
    let sawApiKeyInit = false;
    try {
      for await (const message of query) {
        resetIdle();
        const m = (message ?? {}) as unknown as Record<string, unknown>;
        renderer.push(JSON.stringify(message) + "\n");
        if (typeof m.session_id === "string") sessionId = m.session_id;
        if (m.type === "system" && m.subtype === "init") {
          sawApiKeyInit = m.apiKeySource === "ANTHROPIC_API_KEY";
          if (!sawApiKeyInit) {
            closeQuery();
            void killChildGroup();
            const source =
              typeof m.apiKeySource === "string"
                ? m.apiKeySource.replace(/[^a-zA-Z_ /-]/g, "").slice(0, 40)
                : "unknown";
            throw new ToolRunError(
              this.id,
              1,
              false,
              false,
              `claude-agent refused: the session did not authenticate with the project's API key (apiKeySource=${source})`,
              "",
              false,
              0,
              { sessionId },
            );
          }
        }
        if (m.type === "result") {
          resultsSincePush++;
          lastUsage = usageFromSdkResult(m, opts.resumeBaseline);
          const answered = Array.isArray(m.user_message_uuids)
            ? m.user_message_uuids
            : typeof m.user_message_uuid === "string"
              ? [m.user_message_uuid]
              : undefined;
          if (answered?.includes(latestUuid)) {
            if (!steerInFlight) finalResultSeen = true;
            if (opts.stopSignalPath) {
              try {
                await access(opts.stopSignalPath);
                stopped = true;
                abortController.abort();
                closeQuery();
                void killChildGroup();
                continue;
              } catch {
                /* no stop */
              }
            }
            if (opts.steerSignalPath && opts.onSteer && !lastSteer) {
              try {
                await access(opts.steerSignalPath);
                if (!steerInFlight) boundarySteerPending = true;
                continue;
              } catch {
                /* no pending steer */
              }
            }
          }
          if (!steerInFlight && resultsSincePush > 0 && answered?.includes(latestUuid)) {
            if (!sawApiKeyInit) {
              closeQuery();
              void killChildGroup();
              throw new ToolRunError(
                this.id,
                1,
                false,
                false,
                "claude-agent refused: the session did not authenticate with the project's API key (apiKeySource=unknown)",
                "",
                false,
                0,
                { sessionId },
              );
            }
            result = m;
            boundarySteerPending = false;
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
        { sessionId, usage: lastUsage ?? assistantUsage(renderer.usage) },
      );
    } finally {
      renderer.flush();
      redactor.flush();
      clearInterval(poll);
      if (deadline) clearTimeout(deadline);
      if (idleTimer) clearTimeout(idleTimer);
      if (forceClose) clearTimeout(forceClose);
      queue.end();
      closeQuery();
      if (spawnedChild && spawnedChild.exitCode === null && spawnedChild.signalCode === null)
        await killChildGroup();
      if (childClosed) await childClosed;
    }
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
        { sessionId, usage: lastUsage ?? assistantUsage(renderer.usage) },
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

function assistantUsage(usage?: TokenUsage): TokenUsage | undefined {
  return usage ? { ...usage, known: false } : undefined;
}

async function readRepoFile(cwd: string, name: string): Promise<string> {
  try {
    const root = await realpath(cwd);
    const target = await realpath(resolve(root, name));
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) return "";
    return (await readFile(target, "utf8")).slice(0, 64 * 1024);
  } catch {
    return "";
  }
}

async function readRepoPermissions(cwd: string): Promise<Record<string, string[]> | undefined> {
  const permissions: Record<string, string[]> = {};
  for (const name of [".claude/settings.json", ".claude/settings.local.json"]) {
    const text = await readRepoFile(cwd, name);
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as { permissions?: Record<string, unknown> };
      for (const key of ["allow", "deny", "ask"] as const) {
        const value = parsed.permissions?.[key];
        if (Array.isArray(value))
          permissions[key] = [
            ...new Set([
              ...(permissions[key] ?? []),
              ...value.filter((v): v is string => typeof v === "string"),
            ]),
          ];
      }
    } catch {
      /* malformed project settings are ignored */
    }
  }
  return Object.keys(permissions).length ? permissions : undefined;
}
