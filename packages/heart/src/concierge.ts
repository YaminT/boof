import type { Project, TokenUsage } from "./schema.js";

/** Ledger and budget tool id. Scopes are `tool:concierge` and `project:<id>/tool:concierge`. */
export const CONCIERGE_TOOL_ID = "concierge";

/** Reserved AuthStore prefix. Stored clients are rewritten so they never start with this. */
export const CONCIERGE_PRINCIPAL_PREFIX = "concierge-";

export interface ConciergeAvailability {
  available: boolean;
  reason: string | null;
  via: "gateway" | "project-key" | null;
}

export type ConciergeAgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; phase: "start" | "end"; ok?: boolean };

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
  availability(project: Project): Promise<ConciergeAvailability>;
  turn(input: ConciergeTurnInput): Promise<ConciergeTurnResult>;
}
