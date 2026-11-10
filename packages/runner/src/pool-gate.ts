import { appendEvent, type Settings } from "@boof/heart";
import { ABSENT_POOL, agentKeyIsSeparate, OwlishClient, type PoolStatus } from "@boof/owlish";
import type { Gateway } from "./gateway-env.js";

/** Shown when a pool-routed tool would otherwise receive the admin key. */
export const POOL_AGENT_KEY_REQUIRED =
  "pool routing needs a separate owlishAgentKey; the admin key is not given to task agents";

/** Ask the gateway at most this often (a known `nextAvailableAt` may bring the next check forward). */
export const POOL_POLL_MS = 30_000;
const MIN_SLEEP_MS = 1000;

const BLOCKING = new Set(["degraded", "unhealthy", "unreachable"]);

export interface PoolCheck {
  /** Routed work must not start: the policy is `pause` and the pool is not usable. */
  blocked: boolean;
  pool: PoolStatus;
  policy: "pause" | "warn" | "off" | null;
}

export interface PoolGateOptions {
  /** The data root, for the `runner.pool_exhausted` event. */
  root: string;
  loadSettings: () => Promise<Settings>;
  /**
   * boof's admin ccflare key. Compared in-process so it is never handed to a child, and not
   * sent on the health request. Null when none.
   */
  readKey: () => Promise<string | null>;
  /** The api-only agent key. The only gateway credential a pool-routed child receives. */
  readAgentKey: () => Promise<string | null>;
  now?: () => number;
  /** Tests inject a fake clock: waiting advances it. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The fail-safe pool gate. With `settings.owlish.healthGate = "pause"`, routed work (tools with
 * `acceptsPool`) does not start while the pool is degraded, unhealthy or unreachable, and a
 * running step waits in place. `warn` only reports, `off` does not look, no `settings.owlish`
 * means no gate and no request. The gateway is asked at most every 30 s however often the engine
 * consults the gate; one `runner.pool_exhausted` event is written per blocked episode.
 */
export class PoolGate {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private last?: { at: number; key: string; pool: PoolStatus };
  private episode = false;

  constructor(private readonly opts: PoolGateOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Where routed tools send their requests, or undefined without `settings.owlish`
   * or when the only credential is the admin key. The api key is `owlishAgentKey`
   * only. A gateway with no keys is returned without one. The admin key is never returned.
   */
  async gateway(): Promise<Gateway | undefined> {
    const owlish = (await this.opts.loadSettings()).owlish;
    if (!owlish) return undefined;
    const cred = await this.childCredential();
    if (cred.kind === "blocked") return undefined;
    return { url: owlish.url, ...(cred.apiKey ? { apiKey: cred.apiKey } : {}) };
  }

  /**
   * Why a tool that would receive the pool gateway must not start, or null when it may.
   * Null when no pool is configured, and when the gateway has no client key at all.
   */
  async agentCredentialBlock(): Promise<string | null> {
    const owlish = (await this.opts.loadSettings()).owlish;
    if (!owlish) return null;
    return (await this.childCredential()).kind === "blocked" ? POOL_AGENT_KEY_REQUIRED : null;
  }

  /**
   * `agent` when `owlishAgentKey` is set and distinct from the admin key.
   * `open` when neither key is set (the URL is enough). `blocked` when the admin key
   * is set and there is no separate agent key: that key must not reach a child.
   */
  private async childCredential(): Promise<{
    kind: "agent" | "open" | "blocked";
    apiKey?: string;
  }> {
    let admin: string | null = null;
    let agent: string | null = null;
    try {
      admin = await this.opts.readKey();
    } catch {
      admin = null;
    }
    try {
      agent = await this.opts.readAgentKey();
    } catch {
      agent = null;
    }
    if (agent && agentKeyIsSeparate(admin, agent)) return { kind: "agent", apiKey: agent };
    if (admin) return { kind: "blocked" };
    return { kind: "open" };
  }

  /** The pool and whether routed work is blocked. Never throws on a gateway failure. */
  async check(opts: { fresh?: boolean } = {}): Promise<PoolCheck> {
    const owlish = (await this.opts.loadSettings()).owlish;
    if (!owlish) {
      this.episode = false;
      return { blocked: false, pool: { ...ABSENT_POOL }, policy: null };
    }
    if (owlish.healthGate === "off") {
      this.episode = false;
      return { blocked: false, pool: { ...ABSENT_POOL }, policy: "off" };
    }
    const pool = await this.poll(owlish.url, opts.fresh === true);
    const blocked = owlish.healthGate === "pause" && BLOCKING.has(pool.status);
    if (!blocked) this.episode = false;
    return { blocked, pool, policy: owlish.healthGate };
  }

  private async poll(url: string, fresh = false): Promise<PoolStatus> {
    const t = this.now();
    const last = this.last;
    if (last && last.key === url && !fresh) {
      const age = t - last.at;
      const next = last.pool.nextAvailableAt ? Date.parse(last.pool.nextAvailableAt) : NaN;
      const due = age >= POOL_POLL_MS || (Number.isFinite(next) && t >= next && age >= 5_000);
      if (!due) return last.pool;
    }
    // /health needs no key. The admin key stays out of this request.
    const pool = await new OwlishClient({ url, now: this.now }).health();
    this.last = { at: this.now(), key: url, pool };
    return pool;
  }

  /** Write `runner.pool_exhausted` the first time a blocked episode is seen. Never throws. */
  async announceIfBlocked(check: PoolCheck): Promise<void> {
    if (!check.blocked || this.episode) return;
    this.episode = true;
    try {
      await appendEvent(this.opts.root, {
        type: "runner.pool_exhausted",
        status: check.pool.status as "unreachable" | "degraded" | "unhealthy",
        reason: check.pool.reason ?? "the account pool is not usable",
        nextAvailableAt: check.pool.nextAvailableAt,
        by: "runner",
      });
    } catch (err) {
      console.error("could not record the pool event:", err);
    }
  }

  /**
   * Wait in place until the pool is usable again, for at most `maxMs`. Polls about every 30 s
   * (sooner only at a known next-available time), never faster than once a second. `beforeEachWait`
   * runs before every sleep: the pipeline checks its stop request there and may throw to leave.
   */
  async waitHealthy(opts: {
    maxMs: number;
    log?: (line: string) => Promise<void>;
    beforeEachWait?: () => Promise<void>;
  }): Promise<{ ok: boolean; pool: PoolStatus }> {
    const start = this.now();
    let said = "";
    for (;;) {
      const check = await this.check();
      await this.announceIfBlocked(check);
      if (!check.blocked) return { ok: true, pool: check.pool };
      const left = start + opts.maxMs - this.now();
      if (left <= 0) return { ok: false, pool: check.pool };
      const note = check.pool.nextAvailableAt
        ? `next available ${check.pool.nextAvailableAt}`
        : (check.pool.reason ?? check.pool.status);
      if (said !== note) {
        said = note;
        await opts.log?.(`\n### Waiting for the account pool (${note})`);
      }
      const sinceAsk = this.now() - (this.last?.at ?? this.now());
      const untilPoll = Math.max(POOL_POLL_MS - sinceAsk, 0);
      const duration = Math.min(Math.max(untilPoll, MIN_SLEEP_MS), POOL_POLL_MS, left);
      let remaining = duration;
      while (remaining > 0) {
        await opts.beforeEachWait?.();
        const slice = Math.min(250, remaining);
        await this.sleep(slice);
        remaining -= slice;
      }
    }
  }
}
