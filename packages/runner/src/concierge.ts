import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  BOOF_VERSION,
  ConciergeTurnError,
  SettingsStore,
  conciergeConfigDir,
  conciergeDir,
  conciergeScratchDir,
  type ConciergeAgent,
  type ConciergeAvailability,
  type ConciergeTurnInput,
  type ConciergeTurnResult,
  type Project,
  type TokenUsage,
} from "@boof/heart";
import { OwlishSecretStore, ProjectKeyStore, redactSecrets } from "@boof/owlish";
import {
  AgentAuthRefusedError,
  AgentAuthResolver,
  claudeAgentEnv,
  type AgentAuthResolution,
} from "./agent-auth.js";
import { PoolGate } from "./pool-gate.js";
import { agentMarkerFor } from "./agent-marker.js";
import { createStreamRedactor, usageFromSdkResult } from "./tools/claude-agent.js";
import {
  loadAgentSdk,
  resolveClaudeAgentExecutable,
  type AgentSdk,
} from "./tools/claude-agent-sdk.js";

const BINARY_MESSAGE =
  "Claude Code native binary not found (set BOOF_RUNNER_CLAUDE_AGENT_BIN or install claude)";
const GATEWAY_UNREACHABLE = "the better-ccflare gateway is unreachable; try again shortly";
const MCP_TOOL_PREFIX = "mcp__boof__";
const TOOL_NAME = /^[a-z0-9_]{1,64}$/;

/** Only tools/claude-agent*.ts import the SDK package, so the options type comes from AgentSdk. */
type SdkOptions = NonNullable<Parameters<AgentSdk["query"]>[0]["options"]>;

/** Built-in tools the concierge must not have, even if a preset or config would add them. */
const DISALLOWED_TOOLS = [
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

export interface ClaudeConciergeOptions {
  root: string;
  auth?: AgentAuthResolver;
  pool?: PoolGate;
  loadSdk?: () => Promise<AgentSdk>;
  resolveExecutable?: typeof resolveClaudeAgentExecutable;
  unavailableReason?: string;
  clientApp?: string;
}

function unknownUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, known: false };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnreachable(
  decision: AgentAuthResolution,
): decision is { ok: false; unreachable: true; reason: string } {
  return !decision.ok && "unreachable" in decision && decision.unreachable === true;
}

function refusalMessage(decision: AgentAuthResolution & { ok: false }): string {
  return isUnreachable(decision) ? GATEWAY_UNREACHABLE : decision.reason;
}

function apiKeySourceLabel(value: unknown): string {
  return typeof value === "string" ? value.replace(/[^a-zA-Z_ /-]/g, "").slice(0, 40) : "unknown";
}

async function ensurePrivate(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

/**
 * Empty the model cwd without removing the directory itself. The path and inode stay the same,
 * so a turn already running in it keeps a valid working directory and `resume` keeps working.
 */
async function clearContents(path: string): Promise<void> {
  for (const name of await readdir(path))
    await rm(join(path, name), { recursive: true, force: true });
}

/** Turns running in this process, per scratch directory. Stale files are only cleared at zero. */
const activeScratch = new Map<string, number>();

export class ClaudeConcierge implements ConciergeAgent {
  private readonly root: string;
  private readonly auth: AgentAuthResolver;
  private readonly pool: PoolGate;
  private readonly loadSdk: () => Promise<AgentSdk>;
  private readonly resolveExecutable: typeof resolveClaudeAgentExecutable;
  private readonly unavailableReason?: string;
  private readonly clientApp: string;
  constructor(options: ClaudeConciergeOptions) {
    this.root = options.root;
    this.loadSdk = options.loadSdk ?? loadAgentSdk;
    this.resolveExecutable = options.resolveExecutable ?? resolveClaudeAgentExecutable;
    this.unavailableReason = options.unavailableReason;
    this.clientApp = options.clientApp ?? `boof-runner/${BOOF_VERSION}`;
    // Same construction as RunnerEngine: one settings store, secrets read on each call.
    const settings = options.auth && options.pool ? undefined : new SettingsStore(options.root);
    this.auth =
      options.auth ??
      new AgentAuthResolver({
        root: options.root,
        loadSettings: () => settings!.load(),
        readGatewayKey: () => new OwlishSecretStore(options.root).get(),
        readAgentKey: () => new OwlishSecretStore(options.root).getAgent(),
        projectKeys: new ProjectKeyStore(options.root),
      });
    this.pool =
      options.pool ??
      new PoolGate({
        root: options.root,
        loadSettings: () => settings!.load(),
        readKey: () => new OwlishSecretStore(options.root).get(),
        readAgentKey: () => new OwlishSecretStore(options.root).getAgent(),
      });
  }

  /** Never sends a prompt. The first failed check wins. */
  async availability(project: Project): Promise<ConciergeAvailability> {
    if (this.unavailableReason)
      return { available: false, reason: this.unavailableReason, via: null };
    try {
      await this.loadSdk();
    } catch (error) {
      return { available: false, reason: messageOf(error), via: null };
    }
    const executable = await this.resolveExecutable();
    if (!executable.path && executable.source !== "sdk")
      return { available: false, reason: executable.reason ?? BINARY_MESSAGE, via: null };
    let decision: AgentAuthResolution;
    try {
      decision = await this.auth.decide(project);
    } catch (error) {
      return { available: false, reason: messageOf(error), via: null };
    }
    if (!decision.ok) return { available: false, reason: refusalMessage(decision), via: null };
    if (decision.via === "gateway") {
      try {
        const check = await this.pool.check();
        if (check.blocked)
          return {
            available: false,
            reason: `the account pool is paused or exhausted (${check.pool.status})`,
            via: null,
          };
      } catch (error) {
        return { available: false, reason: messageOf(error), via: null };
      }
    }
    return { available: true, reason: null, via: decision.via };
  }

  async turn(input: ConciergeTurnInput): Promise<ConciergeTurnResult> {
    if (this.unavailableReason)
      throw new ConciergeTurnError(this.unavailableReason, "refused", null, null);
    if (input.signal?.aborted)
      throw new ConciergeTurnError("assistant aborted", "aborted", null, null);

    const decision = await this.auth.decide(input.project, { fresh: true });
    if (!decision.ok) throw new ConciergeTurnError(refusalMessage(decision), "refused", null, null);

    let sdk: AgentSdk;
    try {
      sdk = await this.loadSdk();
    } catch (error) {
      throw new ConciergeTurnError(messageOf(error), "refused", null, null);
    }
    const executable = await this.resolveExecutable();
    if (!executable.path && executable.source !== "sdk")
      throw new ConciergeTurnError(executable.reason ?? BINARY_MESSAGE, "refused", null, null);

    let credentials;
    try {
      credentials = await this.auth.credentials(input.project, decision);
    } catch (error) {
      const message = messageOf(error);
      throw new ConciergeTurnError(
        message,
        error instanceof AgentAuthRefusedError ? "refused" : "failed",
        null,
        null,
      );
    }

    const projectId = input.project.id;
    const configDir = conciergeConfigDir(this.root, projectId);
    const scratch = conciergeScratchDir(this.root, projectId);
    let env: ReturnType<typeof claudeAgentEnv>;
    let released = false;
    const releaseScratch = () => {
      if (released) return;
      released = true;
      const left = (activeScratch.get(scratch) ?? 1) - 1;
      if (left <= 0) activeScratch.delete(scratch);
      else activeScratch.set(scratch, left);
    };
    try {
      await ensurePrivate(conciergeDir(this.root, projectId));
      await ensurePrivate(configDir);
      // Create it if missing; never remove it. The model has no file tools, so nothing is
      // expected inside. Stale files go only when no turn of this process is using it.
      await ensurePrivate(scratch);
      const idle = (activeScratch.get(scratch) ?? 0) === 0;
      activeScratch.set(scratch, (activeScratch.get(scratch) ?? 0) + 1);
      if (idle) await clearContents(scratch);
      env = claudeAgentEnv(
        process.env,
        credentials,
        this.clientApp,
        configDir,
        agentMarkerFor(this.root),
      );
    } catch (error) {
      releaseScratch();
      throw new ConciergeTurnError(
        redactSecrets(messageOf(error), credentials.apiKey ? [credentials.apiKey] : []),
        "failed",
        null,
        null,
      );
    }
    const secrets = credentials.apiKey ? [credentials.apiKey] : [];
    const redact = (text: string) => redactSecrets(text, secrets);
    const abortController = new AbortController();
    let stderr = "";
    const options: SdkOptions = {
      cwd: scratch,
      ...(input.model !== "default" ? { model: input.model } : {}),
      systemPrompt: input.systemPrompt,
      tools: [],
      disallowedTools: DISALLOWED_TOOLS,
      mcpServers: {
        boof: {
          type: "sdk",
          name: input.mcpServerName,
          instance: input.mcpServer as never,
        },
      },
      strictMcpConfig: true,
      allowedTools: [...input.allowedTools],
      permissionMode: "default",
      permissionPrompts: "none",
      settingSources: [],
      extraArgs: { bare: null },
      resume: input.resumeSessionId,
      includePartialMessages: true,
      maxTurns: input.maxTurns,
      maxBudgetUsd: input.maxBudgetUsd,
      env,
      pathToClaudeCodeExecutable: executable.path,
      abortController,
      stderr: (data) => {
        stderr += data;
      },
    };

    let query: ReturnType<AgentSdk["query"]>;
    try {
      query = sdk.query({ prompt: input.prompt, options });
    } catch (error) {
      releaseScratch();
      throw new ConciergeTurnError(redact(messageOf(error)), "failed", null, null);
    }
    let queryClosed = false;
    const closeQuery = () => {
      if (!queryClosed) {
        queryClosed = true;
        query.close();
      }
    };
    const chunks: string[] = [];
    const redactor = createStreamRedactor(secrets, (chunk) => {
      chunks.push(chunk);
      input.onEvent?.({ type: "text", text: chunk });
    });
    const toolsById = new Map<string, string>();
    const pendingTools: string[] = [];
    let sessionId: string | null = null;
    let lastUsage: TokenUsage | undefined;
    let cumulative: TokenUsage | undefined;
    let stopReason: ConciergeTurnResult["stopReason"] | undefined;
    let timedOut = false;
    let aborted = false;

    const deadline = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      closeQuery();
    }, input.timeoutMs);
    const onAbort = () => {
      if (timedOut) return;
      aborted = true;
      abortController.abort();
      closeQuery();
    };
    if (input.signal) input.signal.addEventListener("abort", onAbort, { once: true });

    const noteTool = (name: unknown, id: unknown) => {
      if (typeof name !== "string" || !name.startsWith(MCP_TOOL_PREFIX)) return;
      const tool = name.slice(MCP_TOOL_PREFIX.length);
      if (!TOOL_NAME.test(tool)) return;
      if (typeof id === "string") toolsById.set(id, tool);
      pendingTools.push(tool);
      input.onEvent?.({ type: "tool", tool, phase: "start" });
    };
    const noteResult = (block: Record<string, unknown>) => {
      const id = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
      let tool: string | undefined;
      if (id && toolsById.has(id)) {
        tool = toolsById.get(id);
        toolsById.delete(id);
        const index = pendingTools.indexOf(tool!);
        if (index >= 0) pendingTools.splice(index, 1);
      } else tool = pendingTools.shift();
      if (!tool) return;
      input.onEvent?.({ type: "tool", tool, phase: "end", ok: block.is_error !== true });
    };

    try {
      for await (const message of query) {
        if (timedOut || aborted) break;
        const record = (message ?? {}) as Record<string, unknown>;
        if (typeof record.session_id === "string" && record.session_id)
          sessionId = record.session_id;
        if (record.type === "system" && record.subtype === "init") {
          if (record.apiKeySource !== "ANTHROPIC_API_KEY") {
            closeQuery();
            throw new ConciergeTurnError(
              redact(
                `assistant refused: the session did not authenticate with an API key (apiKeySource=${apiKeySourceLabel(record.apiKeySource)})`,
              ),
              "refused",
              null,
              sessionId,
            );
          }
        }
        if (record.type === "stream_event") {
          const event = record.event as Record<string, unknown> | undefined;
          const delta = event?.delta as Record<string, unknown> | undefined;
          if (
            event?.type === "content_block_delta" &&
            delta?.type === "text_delta" &&
            typeof delta.text === "string"
          )
            redactor.push(delta.text);
        }
        const contentOf = (messageRecord: unknown): unknown[] => {
          const content = (messageRecord as { content?: unknown } | undefined)?.content;
          return Array.isArray(content) ? content : [];
        };
        if (record.type === "assistant") {
          for (const block of contentOf(record.message)) {
            const part = block as { type?: string; name?: unknown; id?: unknown };
            if (part?.type === "tool_use") noteTool(part.name, part.id);
          }
        }
        if (record.type === "user") {
          for (const block of contentOf(record.message)) {
            const part = block as Record<string, unknown>;
            if (part?.type === "tool_result") noteResult(part);
          }
        }
        if (record.type === "result") {
          lastUsage = usageFromSdkResult(record, input.resumeBaseline);
          cumulative = usageFromSdkResult(record);
          const subtype = typeof record.subtype === "string" ? record.subtype : "";
          if (subtype === "success") stopReason = "done";
          else if (subtype === "error_max_turns") stopReason = "max_turns";
          else if (subtype === "error_max_budget_usd") stopReason = "max_budget";
          else {
            const errors = Array.isArray(record.errors) ? record.errors.map(String).join("\n") : "";
            const detail = [errors, stderr].filter(Boolean).join("\n");
            throw new ConciergeTurnError(
              redact(detail || `assistant failed (${subtype || "unknown"})`),
              "failed",
              lastUsage,
              sessionId,
            );
          }
          break;
        }
      }
    } catch (error) {
      if (error instanceof ConciergeTurnError) throw error;
      if (timedOut)
        throw new ConciergeTurnError(
          redact("assistant timed out"),
          "timeout",
          lastUsage ?? unknownUsage(),
          sessionId,
        );
      if (aborted || input.signal?.aborted)
        throw new ConciergeTurnError(
          redact("assistant aborted"),
          "aborted",
          lastUsage ?? unknownUsage(),
          sessionId,
        );
      const detail = [messageOf(error), stderr].filter(Boolean).join("\n");
      throw new ConciergeTurnError(
        redact(detail),
        "failed",
        lastUsage ?? unknownUsage(),
        sessionId,
      );
    } finally {
      redactor.flush();
      clearTimeout(deadline);
      releaseScratch();
      input.signal?.removeEventListener("abort", onAbort);
      closeQuery();
    }

    const text = redact(chunks.join(""));
    if (stopReason && lastUsage && cumulative)
      return { text, sessionId, usage: lastUsage, cumulative, stopReason };
    if (timedOut)
      throw new ConciergeTurnError(
        redact("assistant timed out"),
        "timeout",
        lastUsage ?? unknownUsage(),
        sessionId,
      );
    if (aborted || input.signal?.aborted)
      throw new ConciergeTurnError(
        redact("assistant aborted"),
        "aborted",
        lastUsage ?? unknownUsage(),
        sessionId,
      );
    throw new ConciergeTurnError(
      redact([stderr, "assistant ended without a result"].filter(Boolean).join("\n")),
      "failed",
      lastUsage ?? unknownUsage(),
      sessionId,
    );
  }
}
