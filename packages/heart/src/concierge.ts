import type { Project, TokenUsage } from "./schema.js";

/** Ledger and budget tool id. Scopes are `tool:concierge` and `project:<id>/tool:concierge`. */
export const CONCIERGE_TOOL_ID = "concierge";

/** Reserved AuthStore prefix. Stored clients are rewritten so they never start with this. */
export const CONCIERGE_PRINCIPAL_PREFIX = "concierge-";

export interface ConciergeAvailability {
  available: boolean;
  reason: string | null;
  via: "gateway" | "project-key" | "claude-code" | null;
}

export type ConciergeAgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; phase: "start" | "end"; ok?: boolean };

/** What the server can offer an agent that talks to the tools over HTTP instead of in-process. */
export interface ConciergeEnv {
  /** True when the loopback MCP endpoint is up for this process. */
  bridge: boolean;
}

/** One turn's loopback MCP endpoint. Valid until `close()` or the end of the turn. */
export interface ConciergeBridgeLease {
  url: string;
  /** A per-turn secret. Goes in a 0600 file for the child process, never in argv, env or logs. */
  token: string;
  close(): void;
}

export interface ConciergeBridge {
  open(): ConciergeBridgeLease;
}

export interface ConciergeTurnInput {
  project: Project;
  systemPrompt: string;
  /** The assembled user message. */
  prompt: string;
  /** `"default"` means omit `model`. */
  model: string;
  resumeSessionId?: string;
  /** Cumulative usage at the end of the previous turn. */
  resumeBaseline?: TokenUsage;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  /** An McpServer instance; opaque to Heart and Runner. */
  mcpServer: unknown;
  mcpServerName: "boof";
  /** Present when the server runs the loopback MCP endpoint; claude-code uses it. */
  bridge?: ConciergeBridge;
  /** `mcp__boof__<tool>`. */
  allowedTools: readonly string[];
  onEvent?: (event: ConciergeAgentEvent) => void;
  signal?: AbortSignal;
}

export interface ConciergeTurnResult {
  text: string;
  sessionId: string | null;
  /** This turn only (the resume baseline subtracted). */
  usage: TokenUsage;
  /** As the SDK reported it, for the next baseline. */
  cumulative: TokenUsage;
  stopReason: "done" | "max_turns" | "max_budget";
}

export class ConciergeTurnError extends Error {
  constructor(
    message: string,
    readonly kind: "refused" | "timeout" | "aborted" | "failed",
    readonly usage: TokenUsage | null,
    readonly sessionId: string | null,
  ) {
    super(message);
    this.name = "ConciergeTurnError";
  }
}

export interface ConciergeAgent {
  /** Never sends a prompt and never spends. */
  availability(project: Project, env?: ConciergeEnv): Promise<ConciergeAvailability>;
  turn(input: ConciergeTurnInput): Promise<ConciergeTurnResult>;
}
