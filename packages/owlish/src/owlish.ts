/**
 * Owlish: the client of better-ccflare, an optional account pool that boof calls over HTTP.
 * Account pooling by better-ccflare (MIT, https://github.com/tombii/better-ccflare). Boof holds no
 * provider credentials; the only secret here is boof's one ccflare client key, sent as `x-api-key`
 * and never put into an error message, a log line or a status.
 *
 * Whatever the gateway answers is untrusted: counts must be non-negative integers, the reason is
 * bounded, unknown fields are ignored, and every failure becomes one {@link PoolStatus}.
 */

export type PoolState = "absent" | "unreachable" | "ok" | "degraded" | "unhealthy";

export interface PoolStatus {
  status: PoolState;
  configured: number | null;
  routable: number | null;
  paused: number | null;
  rateLimited: number | null;
  usageExhausted: number | null;
  /** ISO time the first account becomes usable again, when the gateway says. */
  nextAvailableAt: string | null;
  /** Why the pool is not `ok`, for the Now lane and `runner.status`; at most 200 characters. */
  reason: string | null;
}

/** The status of a boof without `settings.owlish`: no gateway, no request, no gate. */
export const ABSENT_POOL: PoolStatus = Object.freeze({
  status: "absent",
  configured: null,
  routable: null,
  paused: null,
  rateLimited: null,
  usageExhausted: null,
  nextAvailableAt: null,
  reason: null,
});

/** One account as the gateway lists it; only these fields are relied on, the rest passes through. */
export interface AccountSummary {
  id: string;
  name: string;
  provider?: string;
  priority?: number;
  paused?: boolean;
  tokenStatus?: string;
  rateLimitStatus?: string;
  rateLimitReset?: string | number | null;
  [extra: string]: unknown;
}

/** Usage-pause thresholds, in percent of a window; passed to the gateway as given. */
export type Thresholds = Record<string, number | null>;

/** A failed gateway call. `status` is the HTTP status, or null when no answer came. */
export class OwlishError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "OwlishError";
  }
}

export interface OwlishClientOptions {
  url: string;
  /** boof's ccflare client key. */
  apiKey?: string;
  fetch?: typeof fetch;
  /** Per request; default 5 s. */
  timeoutMs?: number;
  now?: () => number;
}

const HEALTH_TTL_MS = 10_000;
const REASON_MAX = 200;
const MAX_BODY = 1_000_000;

const bounded = (s: string) => (s.length > REASON_MAX ? `${s.slice(0, REASON_MAX - 1)}…` : s);
const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export class OwlishClient {
  private readonly base: string;
  private readonly apiKey?: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private cached?: { at: number; status: PoolStatus };
  private forcedHealth?: Promise<PoolStatus>;

  constructor(opts: OwlishClientOptions) {
    this.base = opts.url.replace(/\/+$/, "");
    this.apiKey = opts.apiKey || undefined;
    this.doFetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.now = opts.now ?? Date.now;
  }

  /** The pool right now (cached 10 s, failures too). Never throws. */
  async health(force = false): Promise<PoolStatus> {
    if (force) {
      if (this.forcedHealth) return this.forcedHealth;
      const request = this.fetchHealth().then((status) => {
        this.cached = { at: this.now(), status };
        return status;
      });
      this.forcedHealth = request;
      try {
        return await request;
      } finally {
        if (this.forcedHealth === request) this.forcedHealth = undefined;
      }
    }
    const t = this.now();
    if (this.cached && t - this.cached.at < HEALTH_TTL_MS) return this.cached.status;
    const status = await this.fetchHealth();
    this.cached = { at: this.now(), status };
    return status;
  }

  private async fetchHealth(): Promise<PoolStatus> {
    let res: Response;
    let text: string;
    try {
      // /health is exempt from the client key on the gateway: do not send it.
      res = await this.request("GET", "/health", undefined, false);
      text = (await res.text()).slice(0, MAX_BODY);
    } catch {
      return {
        ...ABSENT_POOL,
        status: "unreachable",
        reason: bounded(`better-ccflare at ${this.base}: unreachable`),
      };
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const pool = isRecord(body) && isRecord(body.pool) ? body.pool : {};
    const counts = {
      configured: count(pool.configured),
      routable: count(pool.routable),
      paused: count(pool.paused),
      rateLimited: count(pool.rate_limited),
      usageExhausted: count(pool.usage_exhausted),
      nextAvailableAt: isoOrNull(pool.next_available_at),
    };
    const word = isRecord(body) && typeof body.status === "string" ? body.status : undefined;
    let status: PoolState;
    if (word === "ok" && res.ok) status = counts.routable === 0 ? "degraded" : "ok";
    else if (word === "degraded") status = "degraded";
    else status = "unhealthy";
    const reason =
      status === "ok"
        ? null
        : bounded(
            `better-ccflare at ${this.base}: ${status}` +
              (word === undefined ? ` (HTTP ${res.status}, no usable status)` : "") +
              (counts.routable !== null && counts.configured !== null
                ? `, ${counts.routable} of ${counts.configured} accounts routable`
                : "") +
              (counts.nextAvailableAt ? `, next available ${counts.nextAvailableAt}` : ""),
          );
    return { status, ...counts, reason };
  }

  /** The gateway's accounts. Entries without an id and a name are dropped. */
  async accounts(): Promise<AccountSummary[]> {
    const body = await this.json("GET", "/api/accounts");
    const list = Array.isArray(body)
      ? body
      : isRecord(body) && Array.isArray(body.accounts)
        ? body.accounts
        : [];
    return list.filter(
      (a): a is AccountSummary =>
        isRecord(a) && typeof a.id === "string" && typeof a.name === "string",
    );
  }

  async pause(id: string): Promise<void> {
    await this.mutate(id, "pause");
  }
  async resume(id: string): Promise<void> {
    await this.mutate(id, "resume");
  }
  async setPriority(id: string, priority: number): Promise<void> {
    if (!Number.isInteger(priority) || priority < 0 || priority > 100) {
      throw new OwlishError("priority must be a whole number from 0 to 100", null);
    }
    await this.mutate(id, "priority", { priority });
  }
  async setThresholds(id: string, thresholds: Thresholds): Promise<void> {
    await this.mutate(id, "usage-pause-thresholds", thresholds);
  }

  private async mutate(id: string, action: string, body?: unknown): Promise<void> {
    await this.json("POST", `/api/accounts/${encodeURIComponent(id)}/${action}`, body ?? {});
    this.cached = undefined; // the pool just changed
  }

  private async json(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.request(method, path, body, true);
    } catch {
      throw new OwlishError(`better-ccflare at ${this.base}: unreachable`, null);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new OwlishError(
        `better-ccflare at ${this.base} answered HTTP ${res.status}`,
        res.status,
      );
    }
    try {
      return JSON.parse((await res.text()).slice(0, MAX_BODY));
    } catch {
      return undefined;
    }
  }

  private request(
    method: string,
    path: string,
    body: unknown,
    withKey: boolean,
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (withKey && this.apiKey) headers["x-api-key"] = this.apiKey;
    if (body !== undefined) headers["content-type"] = "application/json";
    return this.doFetch(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "error",
    });
  }
}
