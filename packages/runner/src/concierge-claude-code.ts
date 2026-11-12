import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  ConciergeTurnError,
  SettingsStore,
  conciergeDir,
  conciergeScratchDir,
  conciergeSettings,
  execCommand,
  type ConciergeAgent,
  type ConciergeAvailability,
  type ConciergeEnv,
  type ConciergeTurnInput,
  type ConciergeTurnResult,
  type Project,
  type Settings,
  type TokenUsage,
} from "@boof/heart";
import { OwlishSecretStore, redactSecrets } from "@boof/owlish";
import { agentEnv } from "./agent-env.js";
import { agentMarkerFor } from "./agent-marker.js";
import { gatewayEnv } from "./gateway-env.js";
import { PoolGate } from "./pool-gate.js";
import { DISALLOWED_TOOLS, READ_DENY_RULES } from "./concierge.js";
import { checkInstalled } from "./tools/install-check.js";
import { createStreamRedactor, usageFromSdkResult } from "./tools/claude-agent.js";

const MCP_TOOL_PREFIX = "mcp__boof__";
const TOOL_NAME = /^[a-z0-9_]{1,64}$/;
export const NOT_INSTALLED_REASON = "claude-code is not installed";
export const NO_BRIDGE_REASON =
  "claude-code needs the boof web server for its tools (this process has none, or it uses TLS or a non-loopback address)";
export const NO_ASSISTANT_REASON = "no assistant harness installed";

/**
 * Flags the assistant relies on. Each row is a flag and its spellings; `help` must name one.
 * A missing one makes the adapter unavailable, naming the flag, instead of failing in the turn.
 * `--setting-sources` is required because the user's own hooks and settings must not apply.
 */
const REQUIRED_FLAGS: readonly (readonly string[])[] = [
  ["--output-format"],
  ["--verbose"],
  ["--include-partial-messages"],
  ["--mcp-config"],
  ["--strict-mcp-config"],
  ["--allowedTools", "--allowed-tools"],
  ["--disallowedTools", "--disallowed-tools"],
  ["--setting-sources"],
  ["--system-prompt"],
  ["--tools"],
  ["--settings"],
];

/** Where the user's own claude settings live; `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
const ROUTING_ENV =
  /^(ANTHROPIC_|CLAUDE_CODE_USE_|AWS_|CLOUD_ML_|GOOGLE_|HTTPS?_PROXY$|NO_PROXY$)/i;
const ROUTING_KEYS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh"];

export interface UserRouting {
  /** Provider settings keys that are commands or paths (not secrets); safe in argv. */
  settings: Record<string, string>;
  /** `env` entries that route requests; they go to the child's environment, never argv. */
  env: Record<string, string>;
}

/**
 * The provider routing in the user's claude `settings.json`. The assistant runs with
 * `--setting-sources ""`, which drops it, so the adapter forwards just this subset.
 */
export async function readUserRouting(configDir: string): Promise<UserRouting> {
  const out: UserRouting = { settings: {}, env: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"));
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  const record = parsed as Record<string, unknown>;
  for (const key of ROUTING_KEYS)
    if (typeof record[key] === "string" && record[key]) out.settings[key] = record[key] as string;
  const env = record.env;
  if (env && typeof env === "object")
    for (const [name, value] of Object.entries(env as Record<string, unknown>))
      if (ROUTING_ENV.test(name) && typeof value === "string") out.env[name] = value;
  return out;
}

/** `--max-budget-usd` and `--max-turns` are used when the installed CLI lists them. */
export interface Capabilities {
  missing: string | null;
  maxBudget: boolean;
  maxTurns: boolean;
  noSlashCommands: boolean;
}

export function parseCapabilities(help: string): Capabilities {
  const has = (flag: string) => new RegExp(`(^|[\\s,\\[(])${flag}(?![\\w-])`).test(help);
  const missing = REQUIRED_FLAGS.find((names) => !names.some(has))?.[0] ?? null;
  return {
    missing,
    maxBudget: has("--max-budget-usd"),
    maxTurns: has("--max-turns"),
    noSlashCommands: has("--disable-slash-commands"),
  };
}

export interface ClaudeCodeConciergeOptions {
  root: string;
  /** Program name or path; default `$BOOF_RUNNER_CLAUDE_BIN` or `claude`. */
  bin?: string;
  pool?: PoolGate;
  loadSettings?: () => Promise<Settings>;
  /** How long an install check and a capability check are reused. Default 30 s. */
  cacheMs?: number;
  now?: () => number;
  /** The user's claude config directory; default `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  claudeConfigDir?: string;
}

/** `--resume` takes an optional value, so only a plain session id is passed, joined with `=`. */
const SESSION_ID = /^[0-9a-f-]{8,64}$/i;

function unknownUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, known: false };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The CLI's `result` event carries `usage`, not the SDK's `modelUsage`; adapt it. */
function usageOfResult(record: Record<string, unknown>, baseline?: TokenUsage): TokenUsage {
  const usage = record.usage as Record<string, unknown> | undefined;
  const num = (key: string) => (typeof usage?.[key] === "number" ? (usage[key] as number) : 0);
  const shaped =
    record.modelUsage || !usage
      ? record
      : {
          ...record,
          modelUsage: {
            cli: {
              inputTokens: num("input_tokens"),
              cacheReadInputTokens: num("cache_read_input_tokens"),
              cacheCreationInputTokens: num("cache_creation_input_tokens"),
              outputTokens: num("output_tokens"),
            },
          },
        };
  return usageFromSdkResult(shaped, baseline);
}

/**
 * The console assistant on the user's own `claude` CLI. The CLI runs one headless turn in the
 * empty per-project scratch directory, with every built-in tool off, the user's settings and
 * hooks off, and only boof's concierge tools. It reaches them through the per-turn loopback MCP
 * endpoint the server offers (`input.bridge`). The endpoint address and its token go in a 0600
 * file that is deleted when the turn ends, never in argv, the environment or a log.
 */
export class ClaudeCodeConcierge implements ConciergeAgent {
  private readonly root: string;
  private readonly bin: string;
  private readonly loadSettings: () => Promise<Settings>;
  private readonly pool: PoolGate;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private readonly claudeConfigDir?: string;
  private cache?: {
    at: number;
    installed: { ok: true; path: string; caps: Capabilities } | { ok: false; reason: string };
  };

  constructor(options: ClaudeCodeConciergeOptions) {
    this.root = options.root;
    this.bin = options.bin ?? process.env.BOOF_RUNNER_CLAUDE_BIN ?? "claude";
    this.cacheMs = options.cacheMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.claudeConfigDir = options.claudeConfigDir;
    const settings = options.loadSettings ? undefined : new SettingsStore(options.root);
    this.loadSettings = options.loadSettings ?? (() => settings!.load());
    this.pool =
      options.pool ??
      new PoolGate({
        root: options.root,
        loadSettings: this.loadSettings,
        readKey: () => new OwlishSecretStore(options.root).get(),
        readAgentKey: () => new OwlishSecretStore(options.root).getAgent(),
      });
  }

  private userRouting(): Promise<UserRouting> {
    const dir = this.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    return readUserRouting(dir);
  }

  /** Installed (free `--version`) and capable (`--help`), reused for a short while. */
  private async probe() {
    const cached = this.cache;
    if (cached && this.now() - cached.at < this.cacheMs) return cached.installed;
    const installed = await this.probeNow();
    this.cache = { at: this.now(), installed };
    return installed;
  }

  private async probeNow() {
    const found = await checkInstalled(this.bin);
    if (!found.installed || !found.path)
      return { ok: false as const, reason: `${NOT_INSTALLED_REASON}: ${found.message}` };
    const help = await execCommand(found.path, ["--help"], {
      launch: { kind: "direct" },
      cwd: process.cwd(),
      timeoutMs: 8000,
      env: agentEnv(),
    });
    if (help.code !== 0 || help.timedOut)
      return {
        ok: false as const,
        reason: `claude-code did not list its options (\`--help\` ${help.timedOut ? "timed out" : `exited ${help.code}`})${found.version ? `; version ${found.version}` : ""}`,
      };
    const caps = parseCapabilities(help.stdout + help.stderr);
    if (caps.missing)
      return {
        ok: false as const,
        reason: `this claude-code${found.version ? ` (${found.version})` : ""} lacks ${caps.missing}, which the assistant needs; update it`,
      };
    return { ok: true as const, path: found.path, caps };
  }

  /** Never sends a prompt. The first failed check wins. */
  async availability(_project: Project, env?: ConciergeEnv): Promise<ConciergeAvailability> {
    const no = (reason: string): ConciergeAvailability => ({
      available: false,
      reason,
      via: null,
    });
    const probe = await this.probe();
    if (!probe.ok) return no(probe.reason);
    if (!env?.bridge) return no(NO_BRIDGE_REASON);
    try {
      const settings = await this.loadSettings();
      if (settings.owlish) {
        const block = await this.pool.agentCredentialBlock();
        if (block) return no(block);
        const check = await this.pool.check();
        if (check.blocked)
          return no(`the account pool is paused or exhausted (${check.pool.status})`);
      }
    } catch (error) {
      return no(messageOf(error));
    }
    return { available: true, reason: null, via: "claude-code" };
  }

  async turn(input: ConciergeTurnInput): Promise<ConciergeTurnResult> {
    if (input.signal?.aborted)
      throw new ConciergeTurnError("assistant aborted", "aborted", null, null);
    if (!input.bridge) throw new ConciergeTurnError(NO_BRIDGE_REASON, "refused", null, null);
    if (input.resumeSessionId && !SESSION_ID.test(input.resumeSessionId))
      throw new ConciergeTurnError("invalid assistant session id", "refused", null, null);
    const probe = await this.probe();
    if (!probe.ok) throw new ConciergeTurnError(probe.reason, "refused", null, null);
    const { caps } = probe;

    let settings: Settings;
    let gateway: Awaited<ReturnType<PoolGate["gateway"]>>;
    try {
      settings = await this.loadSettings();
      if (settings.owlish) {
        const block = await this.pool.agentCredentialBlock();
        if (block) throw new ConciergeTurnError(block, "refused", null, null);
      }
      gateway = await this.pool.gateway();
    } catch (error) {
      if (error instanceof ConciergeTurnError) throw error;
      throw new ConciergeTurnError(messageOf(error), "failed", null, null);
    }

    // Without the pool, the user's own provider routing (settings.json) still applies, as for tasks.
    const routing: UserRouting = gateway ? { settings: {}, env: {} } : await this.userRouting();
    const secrets = gateway?.apiKey ? [gateway.apiKey] : [];
    const redact = (text: string) => redactSecrets(text, secrets);
    const childEnv = agentEnv(process.env, settings.runner.agentEnv, agentMarkerFor(this.root), {
      injectPoolCredential: gateway !== undefined,
    });
    if (gateway) {
      delete childEnv.ANTHROPIC_API_KEY;
      delete childEnv.ANTHROPIC_AUTH_TOKEN;
      delete childEnv.CLAUDE_CODE_USE_BEDROCK;
      delete childEnv.CLAUDE_CODE_USE_VERTEX;
      delete childEnv.ANTHROPIC_CUSTOM_HEADERS;
      for (const key of Object.keys(childEnv))
        if (key.startsWith("CLAUDE_CODE_USE_") || key.startsWith("ANTHROPIC_FOUNDRY_"))
          delete childEnv[key];
      Object.assign(childEnv, gatewayEnv("anthropic", gateway));
    } else Object.assign(childEnv, routing.env);
    for (const [name, value] of Object.entries(routing.env))
      if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) && value.length >= 8)
        secrets.push(value);
    // The endpoint is on this machine: never send it through a proxy.
    for (const name of ["NO_PROXY", "no_proxy"]) {
      const entries = (childEnv[name] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      for (const host of ["127.0.0.1", "localhost", "::1"])
        if (!entries.includes(host)) entries.push(host);
      childEnv[name] = entries.join(",");
    }

    const projectId = input.project.id;
    const base = conciergeDir(this.root, projectId);
    const scratch = conciergeScratchDir(this.root, projectId);
    const turnDir = join(base, `turn-${randomBytes(8).toString("hex")}`);
    const lease = input.bridge.open();
    const cleanup = async () => {
      lease.close();
      await rm(turnDir, { recursive: true, force: true }).catch(() => {});
    };
    let configPath: string;
    const stopPath = join(turnDir, "stop");
    try {
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      await chmod(scratch, 0o700);
      await mkdir(turnDir, { recursive: true, mode: 0o700 });
      await chmod(turnDir, 0o700);
      configPath = join(turnDir, "mcp.json");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            [input.mcpServerName]: {
              type: "http",
              url: lease.url,
              headers: { Authorization: `Bearer ${lease.token}` },
            },
          },
        }),
        { mode: 0o600 },
      );
      await chmod(configPath, 0o600);
    } catch (error) {
      await cleanup();
      throw new ConciergeTurnError(redact(messageOf(error)), "failed", null, null);
    }
    secrets.push(lease.token);

    const args = [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      ...(input.model !== "default" ? ["--model", input.model] : []),
      "--system-prompt",
      input.systemPrompt,
      "--strict-mcp-config",
      "--mcp-config",
      configPath,
      "--tools",
      "",
      "--allowedTools",
      input.allowedTools.join(","),
      "--disallowedTools",
      DISALLOWED_TOOLS.join(","),
      "--setting-sources",
      "",
      "--settings",
      JSON.stringify({ ...routing.settings, permissions: { deny: READ_DENY_RULES } }),
      ...(caps.noSlashCommands ? ["--disable-slash-commands"] : []),
      ...(caps.maxTurns ? ["--max-turns", String(input.maxTurns)] : []),
      ...(caps.maxBudget ? ["--max-budget-usd", String(input.maxBudgetUsd)] : []),
      ...(input.resumeSessionId ? [`--resume=${input.resumeSessionId}`] : []),
    ];

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
    let failureDetail = "";
    let assistantTurns = 0;
    let aborted = false;
    let buf = "";

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
    const contentOf = (message: unknown): unknown[] => {
      const content = (message as { content?: unknown } | undefined)?.content;
      return Array.isArray(content) ? content : [];
    };
    const requestStop = () => {
      void writeFile(stopPath, "stop", { mode: 0o600 }).catch(() => {});
    };
    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof record.session_id === "string" && record.session_id) sessionId = record.session_id;
      if (record.type === "stream_event") {
        const event = record.event as Record<string, unknown> | undefined;
        const delta = event?.delta as Record<string, unknown> | undefined;
        if (
          event?.type === "content_block_delta" &&
          delta?.type === "text_delta" &&
          typeof delta.text === "string"
        )
          redactor.push(delta.text);
      } else if (record.type === "assistant") {
        assistantTurns++;
        for (const block of contentOf(record.message)) {
          const part = block as { type?: string; name?: unknown; id?: unknown };
          if (part?.type === "tool_use") noteTool(part.name, part.id);
        }
        // An older CLI without --max-turns: count the model's turns and stop at the limit.
        if (!caps.maxTurns && assistantTurns > input.maxTurns) {
          stopReason = "max_turns";
          requestStop();
        }
      } else if (record.type === "user") {
        for (const block of contentOf(record.message)) {
          const part = block as Record<string, unknown>;
          if (part?.type === "tool_result") noteResult(part);
        }
      } else if (record.type === "result") {
        lastUsage = usageOfResult(record, input.resumeBaseline);
        cumulative = usageOfResult(record);
        const subtype = typeof record.subtype === "string" ? record.subtype : "";
        if (subtype === "success" && record.is_error !== true) {
          // Without --max-budget-usd the cap is checked here, once the cost is known.
          stopReason =
            lastUsage.known && lastUsage.costUsd >= input.maxBudgetUsd ? "max_budget" : "done";
        } else if (subtype === "error_max_turns") stopReason = "max_turns";
        else if (subtype === "error_max_budget_usd") stopReason = "max_budget";
        else {
          const errors = Array.isArray(record.errors) ? record.errors.map(String).join("\n") : "";
          const text = typeof record.result === "string" ? record.result : "";
          failureDetail = [errors, text].filter(Boolean).join("\n") || `failed (${subtype})`;
        }
      }
    };

    const onAbort = () => {
      aborted = true;
      requestStop();
    };
    if (input.signal) input.signal.addEventListener("abort", onAbort, { once: true });

    let res: Awaited<ReturnType<typeof execCommand>>;
    try {
      res = await execCommand(probe.path, args, {
        launch: { kind: "direct" },
        cwd: scratch,
        env: childEnv,
        input: input.prompt,
        timeoutMs: input.timeoutMs,
        stopSignalPath: stopPath,
        stopPollMs: 100,
        onData: (chunk) => {
          buf += chunk;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            handleLine(line);
          }
        },
      });
    } catch (error) {
      throw new ConciergeTurnError(
        redact(messageOf(error)),
        "failed",
        lastUsage ?? unknownUsage(),
        sessionId,
      );
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      if (buf.trim()) handleLine(buf);
      buf = "";
      redactor.flush();
      await cleanup();
    }

    if (res.timedOut)
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
    const text = redact(chunks.join(""));
    if (stopReason) {
      const usage = lastUsage ?? unknownUsage();
      return { text, sessionId, usage, cumulative: cumulative ?? usage, stopReason };
    }
    const detail = [failureDetail, res.stderr.trim()].filter(Boolean).join("\n");
    throw new ConciergeTurnError(
      redact(detail || `assistant ended without a result (exit ${res.code})`),
      "failed",
      lastUsage ?? unknownUsage(),
      sessionId,
    );
  }
}

export interface AutoConciergeOptions {
  agent: ConciergeAgent;
  code: ConciergeAgent;
  loadSettings: () => Promise<Settings>;
}

/**
 * Picks the assistant harness from `settings.concierge.tool`. `auto` uses claude-agent when it
 * is available, else claude-code when it is installed, else reports that no harness is installed.
 */
export class AutoConcierge implements ConciergeAgent {
  constructor(private readonly options: AutoConciergeOptions) {}

  private async pick(
    project: Project,
    env?: ConciergeEnv,
  ): Promise<{ agent: ConciergeAgent | null; availability: ConciergeAvailability }> {
    const tool = conciergeSettings(await this.options.loadSettings()).tool;
    if (tool === "claude-agent")
      return {
        agent: this.options.agent,
        availability: await this.options.agent.availability(project, env),
      };
    if (tool === "claude-code")
      return {
        agent: this.options.code,
        availability: await this.options.code.availability(project, env),
      };
    const first = await this.options.agent.availability(project, env);
    if (first.available) return { agent: this.options.agent, availability: first };
    const second = await this.options.code.availability(project, env);
    if (second.available) return { agent: this.options.code, availability: second };
    // claude-code is installed but cannot run (pool, version, no endpoint): say why.
    if (!second.reason?.startsWith(NOT_INSTALLED_REASON))
      return { agent: null, availability: second };
    return {
      agent: null,
      availability: {
        available: false,
        reason: `${NO_ASSISTANT_REASON} (claude-agent: ${first.reason ?? "unavailable"}; claude-code: ${second.reason})`,
        via: null,
      },
    };
  }

  async availability(project: Project, env?: ConciergeEnv): Promise<ConciergeAvailability> {
    return (await this.pick(project, env)).availability;
  }

  async turn(input: ConciergeTurnInput): Promise<ConciergeTurnResult> {
    const { agent, availability } = await this.pick(input.project, { bridge: !!input.bridge });
    if (!agent)
      throw new ConciergeTurnError(availability.reason ?? "unavailable", "refused", null, null);
    return agent.turn(input);
  }
}
