import { randomBytes } from "node:crypto";
import {
  AccountsStore,
  PROVIDER,
  freshState,
  isAnthropicApiKey,
  type AccountRecord,
  type AccountState,
} from "./accounts-store.js";
import { CREDIT_RECHECK_MS, type Outcome } from "./limits.js";

export type Strategy = "ordered" | "round-robin";

/** Same shape and words as the better-ccflare `PoolStatus` that boof reads today. */
export type PoolState = "absent" | "unreachable" | "ok" | "degraded" | "unhealthy";
export interface PoolStatus {
  status: PoolState;
  configured: number | null;
  routable: number | null;
  paused: number | null;
  rateLimited: number | null;
  usageExhausted: number | null;
  nextAvailableAt: string | null;
  reason: string | null;
}

/** One account as the Accounts page renders it; never carries the key. */
export interface AccountSummary {
  id: string;
  name: string;
  provider: typeof PROVIDER;
  hasRefreshToken: false;
  priority: number;
  paused: boolean;
  pauseReason: "manual" | "auth" | null;
  rateLimitStatus: "allowed" | "rate_limited" | "usage_exhausted";
  rateLimitReset: string | null;
  lastUsed: string | null;
  requestCount: number;
}

export interface PoolOptions {
  store: AccountsStore;
  /** Epoch ms; injected so tests never use real time. */
  now?: () => number;
  strategy?: Strategy;
  newId?: () => string;
  /** How long counter-only state changes wait before they are written; default 1000 ms. */
  persistDebounceMs?: number;
}

export interface PickedAccount {
  id: string;
  apiKey: string;
}

const NAME_MAX = 80;
type Availability = "paused" | "usage_exhausted" | "rate_limited" | "routable";

/**
 * The account pool. Selection per request, pause until reset, and a `PoolStatus` built from the
 * state. Holds API-key accounts only. State changes are written behind the call (`flush()`
 * waits for them); the admin calls (`add`, `remove`, `pause`, ...) wait for the write.
 */
export class Pool {
  private accounts: AccountRecord[] = [];
  private state = new Map<string, AccountState>();
  private readonly store: AccountsStore;
  private readonly now: () => number;
  private readonly newId: () => string;
  private strategy: Strategy;
  private lastPicked: string | null = null;
  private writing: Promise<void> = Promise.resolve();
  private writeError: unknown;
  private signature = "";
  private readonly resumeSeen = new Map<string, number>();
  private adminQueue: Promise<unknown> = Promise.resolve();
  private readonly debounceMs: number;
  private timer: NodeJS.Timeout | undefined;

  private constructor(opts: PoolOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.strategy = opts.strategy ?? "ordered";
    this.debounceMs = opts.persistDebounceMs ?? 1000;
    this.newId = opts.newId ?? (() => `acc-${randomBytes(6).toString("hex")}`);
  }

  static async open(opts: PoolOptions): Promise<Pool> {
    const pool = new Pool(opts);
    await opts.store.tighten();
    pool.signature = opts.store.signature();
    pool.accounts = await opts.store.loadAccounts();
    const saved = await opts.store.loadState();
    for (const a of pool.accounts) {
      pool.state.set(a.id, saved.get(a.id) ?? freshState());
      pool.resumeSeen.set(a.id, a.resumedAt ?? 0);
    }
    pool.syncFlags(pool.accounts);
    return pool;
  }

  setStrategy(strategy: Strategy): void {
    this.strategy = strategy;
  }

  // ---- admin -------------------------------------------------------------------------------

  async add(input: { name: string; apiKey: string; priority?: number }): Promise<AccountSummary> {
    const name = input.name.trim();
    if (name.length < 1 || name.length > NAME_MAX) {
      throw new Error(`the name must be 1-${NAME_MAX} characters`);
    }
    if (!isAnthropicApiKey(input.apiKey)) {
      throw new Error("the key must be an Anthropic Console API key (sk-ant-api…)");
    }
    if (input.priority !== undefined) this.checkPriority(input.priority);
    return this.admin(async () => {
      const { result, accounts, signature } = await this.store.update((current) => {
        const priority = input.priority ?? nextPriority(current);
        this.checkPriority(priority);
        if (current.some((a) => a.apiKey === input.apiKey)) {
          throw new Error("that key is already in the pool");
        }
        const record: AccountRecord = {
          id: this.newId(),
          name,
          provider: PROVIDER,
          apiKey: input.apiKey,
          priority,
          createdAt: new Date(this.now()).toISOString(),
        };
        return { accounts: [...current, record], result: record };
      });
      this.adopt(accounts, signature);
      await this.persistNow();
      return this.summary(result);
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.admin(async () => {
      const { result, accounts, signature } = await this.store.update((current) => {
        const next = current.filter((a) => a.id !== id);
        return { accounts: next, result: next.length !== current.length };
      });
      this.adopt(accounts, signature);
      if (this.lastPicked === id) this.lastPicked = null;
      await this.persistNow();
      return result;
    });
  }

  async setPriority(id: string, priority: number): Promise<boolean> {
    this.checkPriority(priority);
    return this.admin(async () => {
      const { result, accounts, signature } = await this.store.update((current) => ({
        accounts: current.map((x) => (x.id === id ? { ...x, priority } : x)),
        result: current.some((x) => x.id === id),
      }));
      this.adopt(accounts, signature);
      return result;
    });
  }

  async pause(id: string): Promise<boolean> {
    return this.admin(async () => {
      const { result, accounts, signature } = await this.store.update((current) => ({
        accounts: current.map((x) => (x.id === id ? { ...x, paused: true } : x)),
        result: current.some((x) => x.id === id),
      }));
      this.adopt(accounts, signature);
      await this.persistNow();
      return result;
    });
  }

  /** Clears a manual or auth pause and any rate-limit or credit wait, in every process. */
  async resume(id: string): Promise<boolean> {
    return this.admin(async () => {
      const { result, accounts, signature } = await this.store.update((current) => ({
        accounts: current.map((x) => {
          if (x.id !== id) return x;
          const { paused: _paused, ...rest } = x;
          return { ...rest, resumedAt: Math.max(this.now(), (x.resumedAt ?? 0) + 1) };
        }),
        result: current.some((x) => x.id === id),
      }));
      this.adopt(accounts, signature);
      await this.persistNow();
      return result;
    });
  }

  // ---- per request ---------------------------------------------------------------------------

  /**
   * The account to use for one request, or null when none can take traffic. `exclude` holds
   * accounts that already failed this request. Counts the request and remembers the choice.
   */
  pick(exclude: Iterable<string> = []): PickedAccount | null {
    this.refresh();
    const skip = new Set(exclude);
    const usable = this.sorted().filter(
      (a) => !skip.has(a.id) && this.availability(a.id) === "routable",
    );
    if (usable.length === 0) return null;
    let chosen: AccountRecord;
    if (this.strategy === "round-robin") {
      // Rotation follows the full order, so a skipped account does not break the cycle.
      const order = this.sorted();
      const from = order.findIndex((a) => a.id === this.lastPicked);
      const ids = new Set(usable.map((a) => a.id));
      let found: AccountRecord | undefined;
      for (let i = 1; i <= order.length && !found; i++) {
        const candidate = order[(from + i + order.length) % order.length]!;
        if (ids.has(candidate.id)) found = candidate;
      }
      chosen = found ?? usable[0]!;
    } else {
      const best = usable[0]!.priority;
      const tied = usable.filter((a) => a.priority === best);
      chosen = tied.find((a) => a.id === this.lastPicked) ?? tied[0]!;
    }
    this.lastPicked = chosen.id;
    const s = this.stateOf(chosen.id);
    s.lastUsed = this.now();
    s.requestCount += 1;
    this.persist();
    return { id: chosen.id, apiKey: chosen.apiKey };
  }

  /** Apply the outcome of a request to its account. */
  report(id: string, outcome: Outcome, httpStatus?: number): void {
    const s = this.state.get(id);
    if (!s) return;
    if (httpStatus !== undefined) s.lastStatus = httpStatus;
    switch (outcome.kind) {
      case "rate_limited":
        s.rateLimitedUntil = outcome.until;
        break;
      case "auth":
        s.paused = true;
        s.pauseReason = "auth";
        break;
      case "credit":
        s.usageExhaustedAt = this.now();
        break;
      case "ok":
      case "transient":
      case "other":
        break;
    }
    // A pause or wait is written at once; counters wait for the debounce.
    this.persist(
      outcome.kind === "auth" || outcome.kind === "credit" || outcome.kind === "rate_limited",
    );
  }

  /** Count tokens for an account (counters only). */
  recordUsage(id: string, usage: { inputTokens?: number; outputTokens?: number }): void {
    const s = this.state.get(id);
    if (!s) return;
    const add = (n: number | undefined) => (Number.isFinite(n) && n! > 0 ? Math.floor(n!) : 0);
    s.inputTokens += add(usage.inputTokens);
    s.outputTokens += add(usage.outputTokens);
    this.persist();
  }

  // ---- views ---------------------------------------------------------------------------------

  accountList(): AccountSummary[] {
    this.refresh();
    return this.sorted().map((a) => this.summary(a));
  }

  /** The pool right now, built from account state and the clock. */
  status(): PoolStatus {
    this.refresh();
    const configured = this.accounts.length;
    const counts = { paused: 0, rateLimited: 0, usageExhausted: 0, routable: 0 };
    let next: number | null = null;
    for (const a of this.accounts) {
      const av = this.availability(a.id);
      if (av === "paused") counts.paused++;
      else if (av === "usage_exhausted") counts.usageExhausted++;
      else if (av === "rate_limited") counts.rateLimited++;
      else counts.routable++;
      const back = this.availableAt(a.id);
      if (back !== null && (next === null || back < next)) next = back;
    }
    const base = { configured, ...counts };
    if (configured === 0) {
      return {
        status: "absent",
        ...base,
        nextAvailableAt: null,
        reason: "No accounts in the pool",
      };
    }
    if (counts.routable === configured) {
      return { status: "ok", ...base, nextAvailableAt: null, reason: null };
    }
    const parts = [
      counts.paused ? `${counts.paused} paused` : "",
      counts.rateLimited ? `${counts.rateLimited} rate-limited` : "",
      counts.usageExhausted ? `${counts.usageExhausted} out of credit` : "",
    ].filter(Boolean);
    if (counts.routable > 0) {
      return {
        status: "degraded",
        ...base,
        nextAvailableAt: null,
        reason: `${configured - counts.routable} of ${configured} accounts unavailable: ${parts.join(", ")}`,
      };
    }
    return {
      status: "unhealthy",
      ...base,
      nextAvailableAt: next === null ? null : new Date(next).toISOString(),
      reason: `No account can take requests: ${parts.join(", ")}`,
    };
  }

  /** Every key in the pool, for redacting logs and errors. Never log the result. */
  secrets(): string[] {
    this.refresh();
    return this.accounts.map((a) => a.apiKey);
  }

  /** Wait for queued state writes; rethrows the last write failure once. */
  async flush(): Promise<void> {
    if (this.timer) this.persist(true);
    await this.writing;
    if (this.writeError !== undefined) {
      const err = this.writeError;
      this.writeError = undefined;
      throw err;
    }
  }

  // ---- internals -----------------------------------------------------------------------------

  private stateOf(id: string): AccountState {
    let s = this.state.get(id);
    if (!s) this.state.set(id, (s = freshState()));
    return s;
  }

  private sorted(): AccountRecord[] {
    return [...this.accounts].sort(
      (a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt),
    );
  }

  private checkPriority(p: number): void {
    if (!Number.isInteger(p) || p < 0 || p > 100) {
      throw new Error("the priority must be a whole number from 0 to 100");
    }
  }

  private availability(id: string): Availability {
    const s = this.stateOf(id);
    const t = this.now();
    if (s.paused) return "paused";
    if (s.usageExhaustedAt !== null && t < s.usageExhaustedAt + CREDIT_RECHECK_MS) {
      return "usage_exhausted";
    }
    if (s.rateLimitedUntil !== null && t < s.rateLimitedUntil) return "rate_limited";
    return "routable";
  }

  /** When an unavailable, unpaused account is usable again (epoch ms), else null. */
  private availableAt(id: string): number | null {
    const s = this.stateOf(id);
    const av = this.availability(id);
    if (av === "usage_exhausted")
      return Math.max(s.usageExhaustedAt! + CREDIT_RECHECK_MS, s.rateLimitedUntil ?? 0);
    if (av === "rate_limited") return s.rateLimitedUntil;
    return null;
  }

  private summary(a: AccountRecord): AccountSummary {
    const s = this.stateOf(a.id);
    const av = this.availability(a.id);
    const reset = av === "paused" ? null : this.availableAt(a.id);
    return {
      id: a.id,
      name: a.name,
      provider: a.provider,
      hasRefreshToken: false,
      priority: a.priority,
      paused: s.paused,
      pauseReason: s.pauseReason,
      rateLimitStatus: av === "paused" || av === "routable" ? "allowed" : av,
      rateLimitReset: reset === null ? null : new Date(reset).toISOString(),
      lastUsed: s.lastUsed === null ? null : new Date(s.lastUsed).toISOString(),
      requestCount: s.requestCount,
    };
  }

  /** Run an admin change after the ones before it (a queue per Pool; the store adds the file lock). */
  private admin<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.adminQueue.then(fn, fn);
    this.adminQueue = run.catch(() => {});
    return run;
  }

  /** Take the list a locked write just produced as the current one. */
  private adopt(accounts: AccountRecord[], signature: string): void {
    this.signature = signature;
    this.applyAccounts(accounts);
  }

  private applyAccounts(accounts: AccountRecord[]): void {
    this.accounts = accounts;
    const ids = new Set(accounts.map((a) => a.id));
    for (const id of [...this.state.keys()]) if (!ids.has(id)) this.state.delete(id);
    for (const a of accounts) if (!this.state.has(a.id)) this.state.set(a.id, freshState());
    this.syncFlags(accounts);
  }

  /** Apply the cross-process flags in accounts.json (manual pause, resume marker) to local state. */
  private syncFlags(accounts: AccountRecord[]): void {
    for (const a of accounts) {
      const s = this.stateOf(a.id);
      const seen = this.resumeSeen.get(a.id);
      const stamp = a.resumedAt ?? 0;
      if (seen !== undefined && stamp !== seen) {
        s.paused = false;
        s.pauseReason = null;
        s.rateLimitedUntil = null;
        s.usageExhaustedAt = null;
      }
      this.resumeSeen.set(a.id, stamp);
      if (a.paused) {
        s.paused = true;
        s.pauseReason = "manual";
      } else if (s.pauseReason === "manual") {
        s.paused = false;
        s.pauseReason = null;
      }
    }
  }

  /** Pick up accounts.json when another process (or an edit) changed it. A bad file keeps the old list. */
  private refresh(): void {
    const sig = this.store.signature();
    if (sig === this.signature) return;
    try {
      const accounts = this.store.loadAccountsSync();
      this.signature = sig;
      this.applyAccounts(accounts);
    } catch {
      // keep serving the last good list; retried on the next change
    }
  }

  private persist(immediate = false): void {
    if (!immediate) {
      if (this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.persist(true);
      }, this.debounceMs);
      this.timer.unref();
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.refresh(); // pick up a pause/resume written by another process before persisting
    const snapshot = new Map([...this.state].map(([k, v]) => [k, { ...v }] as const));
    this.writing = this.writing
      .then(() => this.store.saveState(snapshot))
      .catch((err: unknown) => {
        this.writeError = err;
      });
  }

  private async persistNow(): Promise<void> {
    this.persist(true);
    await this.flush();
  }
}

function nextPriority(accounts: AccountRecord[]): number {
  return Math.min(
    100,
    accounts.reduce((m, a) => Math.max(m, a.priority + 1), 0),
  );
}
