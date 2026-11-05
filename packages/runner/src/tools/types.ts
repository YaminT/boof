import type { HealthResult, Role, TokenUsage } from "@boof/heart";
import type { AgentAuth } from "@boof/owlish";
import type { Gateway } from "../gateway-env.js";

export type { Gateway } from "../gateway-env.js";

// The health types are Heart's (tool-catalog.ts); Runner re-exports them so adapters do not change.
export type { HealthResult, HealthStatus } from "@boof/heart";

export interface DetectOptions {
  /** As `RunOptions.inheritMcpServers`: false (default) keeps the probe away from the user's MCP servers. */
  inheritMcpServers?: boolean;
}

export interface RunOptions {
  role: Role;
  model: string;
  systemPrompt: string;
  prompt: string;
  /** Working directory (the per-task worktree, or the working directory). */
  cwd: string;
  /** Per-project Claude configuration directory under the boof data root. */
  claudeConfigDir?: string;
  /** Explicit, credential-scrubbed environment prepared for claude-agent. */
  env?: Record<string, string>;
  /** Auto mode: pass non-interactive / no-permission-prompt flags. */
  autoApprove: boolean;
  /**
   * Let the agent load the user's own MCP servers (`runner.inheritMcpServers`). Default false: the
   * claude adapter then passes `--strict-mcp-config` and codex `--ignore-user-config`. opencode
   * reads its own config and has no flag boof can rely on, so it is not isolated.
   */
  inheritMcpServers?: boolean;
  /** Extra environment variable names the agent may inherit (`runner.agentEnv`); see `agentEnv()`. */
  agentEnv?: readonly string[];
  /**
   * Route this run through the account pool: the tool adds the gateway's base URL and key to its
   * child's environment. Set by the pipeline only for tools with `acceptsPool`, and only when a
   * pool is configured.
   */
  gateway?: Gateway;
  /** Optional timeout for this run. */
  timeoutMs?: number;
  /**
   * Called with each output chunk as the tool emits it, so the pipeline can
   * stream live progress to the UI (live-output spec). Optional: tools that
   * cannot stream simply never call it.
   */
  onChunk?: (chunk: string) => void;
  /** Kill the tool process when it prints nothing for this long (stalled stream). */
  idleTimeoutMs?: number;
  /** File whose presence requests cancellation of the running tool process. */
  stopSignalPath?: string;
  /** File whose presence interrupts the tool process so the step can be rerun with new instructions. */
  steerSignalPath?: string;
  /** File that holds the tool process group while it runs (see taskPidPath). */
  pidFilePath?: string;
  /**
   * Continue the tool's earlier session (its id from `RunResult.sessionId` or
   * `ToolRunError.sessionId`); `prompt` is then only the new message. Used when a step is
   * steered. Ignored by tools without `supportsResume`.
   */
  resumeSessionId?: string;
  /** Explicit per-project Claude Agent SDK credentials, set by the pipeline. */
  agentAuth?: AgentAuth;
  /** In-place steering request source, consumed by resumable adapters. */
  onSteer?: () => Promise<SteerRequest>;
  /** Cumulative SDK usage at the start of a resumed session. */
  resumeBaseline?: TokenUsage;
}

export type SteerRequest = { texts: string[]; model?: string; last: boolean };

export interface RunResult {
  /** Raw combined output captured from the tool (also written to log.txt). */
  output: string;
  /** The role's written report (plan / developer notes / review). */
  report: string;
  /** Clarifying questions, if the tool raised any (planner park loop). */
  questions?: string[];
  /** Best-effort token usage parsed from the output. */
  usage?: TokenUsage;
  /** The tool's session id when its output carries one (resume support). */
  sessionId?: string;
}

/**
 * Pluggable coding-agent tool. New tools implement this interface and register
 * themselves; the pipeline never references concrete tools (tool-adapters spec).
 */
export interface Tool {
  id: string;
  displayName: string;
  defaultModels: string[];
  /** Check that the tool is installed and usable (sends a short, paid prompt). */
  detect(opts?: DetectOptions): Promise<HealthResult>;
  listModels(): Promise<string[]>;
  /** True when `run` honours `resumeSessionId`; otherwise a steered step restarts. */
  readonly supportsResume?: boolean;
  /** True when `run` honours `RunOptions.gateway` (the tool can be served by the account pool). */
  readonly acceptsPool?: boolean;
  /** Requires a fresh per-project Agent SDK authentication decision before running. */
  readonly needsAgentAuth?: boolean;
  /** Handles `now` injections in the current session through interrupt and streamed input. */
  readonly steersInPlace?: boolean;
  /** Fixed reason shown when this tool is intentionally unavailable in this composition. */
  readonly unavailableReason?: string;
  run(opts: RunOptions): Promise<RunResult>;
}
