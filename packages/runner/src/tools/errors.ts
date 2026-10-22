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
  ) {
    super(
      stopped
        ? `${toolId} stopped by user`
        : timedOut
          ? `${toolId} timed out`
          : stalled
            ? `${toolId} stalled: no output for ${+(idleMs / 60000).toFixed(1)} min`
            : `${toolId} exited with code ${code ?? "null"}`,
    );
    this.name = "ToolRunError";
  }
}

const TRANSIENT =
  /API Error:\s*(5\d\d|429)\b|\b(429|529)\b|overloaded|temporarily unavailable|ECONNRESET|ETIMEDOUT|socket hang up/i;

/** First output line that looks like a transient API/network error, or null. */
export function transientReason(err: unknown): string | null {
  if (!(err instanceof ToolRunError) || err.stopped || err.timedOut) return null;
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
