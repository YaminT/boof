import { createHash, randomBytes } from "node:crypto";

export const TOKEN_PREFIX = "bgw_";
export const MAX_TOKEN_TTL_MS = 24 * 60 * 60_000;

export interface RunTokenInfo {
  runId: string;
  projectId: string | null;
  expiresAt: number;
}

export interface TokenStoreOptions {
  /** Epoch ms; injected so tests never use real time. */
  now?: () => number;
  /** Source of token entropy (32 bytes); injected for tests. */
  randomBytes?: (size: number) => Buffer;
}

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * Per-run loopback tokens. A token is 256 random bits, kept only as a SHA-256 hash, so a lookup
 * does not compare the secret itself and the raw value is never stored. Tokens expire and can
 * be revoked, one by one or by run. Memory only: they die with the process.
 */
export class TokenStore {
  private readonly tokens = new Map<string, RunTokenInfo>();
  private readonly now: () => number;
  private readonly entropy: (size: number) => Buffer;

  constructor(opts: TokenStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.entropy = opts.randomBytes ?? randomBytes;
  }

  /** Mint a token for a run; `ttlMs` is the step timeout plus a margin. */
  mint(input: { runId: string; projectId?: string | null; ttlMs: number }): string {
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > MAX_TOKEN_TTL_MS) {
      throw new Error("ttlMs must be between 1 ms and 24 hours");
    }
    if (!input.runId) throw new Error("runId is required");
    this.sweep();
    const token = TOKEN_PREFIX + this.entropy(32).toString("base64url");
    this.tokens.set(hash(token), {
      runId: input.runId,
      projectId: input.projectId ?? null,
      expiresAt: this.now() + input.ttlMs,
    });
    return token;
  }

  /** The run a live token belongs to, or null (unknown, revoked or expired). */
  verify(token: string | undefined | null): RunTokenInfo | null {
    if (!token || !token.startsWith(TOKEN_PREFIX) || token.length > 256) return null;
    const key = hash(token);
    const info = this.tokens.get(key);
    if (!info) return null;
    if (this.now() >= info.expiresAt) {
      this.tokens.delete(key);
      return null;
    }
    return { ...info };
  }

  revoke(token: string): boolean {
    return this.tokens.delete(hash(token));
  }

  /** Revoke every token of one run; returns how many. */
  revokeRun(runId: string): number {
    let n = 0;
    for (const [key, info] of this.tokens) {
      if (info.runId === runId) {
        this.tokens.delete(key);
        n++;
      }
    }
    return n;
  }

  /** Drop expired tokens. */
  sweep(): void {
    const t = this.now();
    for (const [key, info] of this.tokens) if (t >= info.expiresAt) this.tokens.delete(key);
  }

  get size(): number {
    this.sweep();
    return this.tokens.size;
  }
}
