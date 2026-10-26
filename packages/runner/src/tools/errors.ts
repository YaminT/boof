import type { TokenUsage } from "@boof-runner/shared";

/** Optional details of a failed run that the pipeline uses to continue the step. */
export interface ToolRunErrorExtra {
  /** The step was interrupted by a steer request (not a stop): rerun it with the new prompt. */
  steered?: boolean;
  /** The tool session id seen in the output so far, to resume it. */
  sessionId?: string;
  /** Usage of the interrupted attempt, still recorded. */
  usage?: TokenUsage;
}

/** A tool process failed: non-zero exit, timeout, user stop or a stalled stream. */
export class ToolRunError extends Error {
  constructor(
    public readonly toolId: string,
    public readonly code: number | null,
    public readonly timedOut: boolean,
    public readonly stopped: boolean,
    public readonly output: string,
    public readonly stderr = "",
    public readonly stalled = false,
    /** Idle limit (ms) that was exceeded when `stalled`. */
    idleMs = 0,
    extra: ToolRunErrorExtra = {},
  ) {
    super(
      extra.steered
        ? `${toolId} interrupted to apply a new prompt`
        : stopped
          ? `${toolId} stopped by user`
          : timedOut
            ? `${toolId} timed out`
            : stalled
              ? `${toolId} stalled: no output for ${+(idleMs / 60000).toFixed(1)} min`
              : `${toolId} exited with code ${code ?? "null"}`,
    );
    this.name = "ToolRunError";
    this.steered = extra.steered === true;
    this.sessionId = extra.sessionId;
    this.usage = extra.usage;
  }

  readonly steered: boolean;
  readonly sessionId?: string;
  readonly usage?: TokenUsage;
}

const TRANSIENT =
  /API Error:\s*(5\d\d|429)\b|\b(429|529)\b|overloaded|temporarily unavailable|ECONNRESET|ETIMEDOUT|socket hang up/i;

/** First output line that looks like a transient API/network error, or null. */
export function transientReason(err: unknown): string | null {
  if (!(err instanceof ToolRunError) || err.stopped || err.steered || err.timedOut) return null;
  if (err.stalled) return err.message;
  for (const line of `${err.output}\n${err.stderr}`.split("\n")) {
    if (TRANSIENT.test(line)) return line.trim().slice(0, 200);
  }
  return null;
}

/**
 * True for a tool failure worth retrying in the same worktree: a ToolRunError
 * that was neither stopped nor timed out and either stalled or whose output or
 * stderr shows a transient API or network error (5xx, 429, 529, overloaded,
 * temporarily unavailable, ECONNRESET, ETIMEDOUT, socket hang up).
 */
export function isTransientToolError(err: unknown): boolean {
  return transientReason(err) !== null;
}
