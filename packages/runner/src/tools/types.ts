import type { Role, TokenUsage } from "@boof-runner/shared";

export type HealthStatus = "available" | "unavailable";

export interface HealthResult {
  status: HealthStatus;
  /** Human-readable detail for the settings health-check UI. */
  message: string;
  /** Resolved version string when available. */
  version?: string;
}

export interface RunOptions {
  role: Role;
  model: string;
  systemPrompt: string;
  prompt: string;
  /** Working directory (the per-task worktree, or the working directory). */
  cwd: string;
  /** Auto mode: pass non-interactive / no-permission-prompt flags. */
  autoApprove: boolean;
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
  /**
   * Continue the tool's earlier session (its id from `RunResult.sessionId` or
   * `ToolRunError.sessionId`); `prompt` is then only the new message. Used when a step is
   * steered. Ignored by tools without `supportsResume`.
   */
  resumeSessionId?: string;
}

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
  detect(): Promise<HealthResult>;
  listModels(): Promise<string[]>;
  /** True when `run` honours `resumeSessionId`; otherwise a steered step restarts. */
  readonly supportsResume?: boolean;
  run(opts: RunOptions): Promise<RunResult>;
}
