import { join } from "node:path";
import {
  AccountsStore,
  GatewayServer,
  defaultCcflareDb,
  importCcflare,
  summariseCcflare,
  CcflareImportError,
  type CcflareImportResult,
  Pool,
  TokenStore,
  type AccountSummary as InternalAccountSummary,
  type GatewayServerOptions,
  type Strategy,
} from "@boof/gateway";
import type { AccountSummary, PoolStatus } from "./owlish.js";

/** Where a routed child sends its requests: the gateway URL and the credential it may use. */
export interface ChildGateway {
  url: string;
  apiKey: string;
}

/**
 * What the ops, the pool gate and the runner need from an account pool. `OwlishClient`
 * (better-ccflare, over HTTP) and {@link InternalPoolBackend} (boof's own loopback gateway)
 * both answer it; `OwlishClient` keeps its own signatures and is not wrapped.
 */
export interface PoolBackend {
  health(): Promise<PoolStatus>;
  accounts(): Promise<AccountSummary[]>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  setPriority(id: string, priority: number): Promise<void>;
}

/** A pool call that cannot be answered, with the HTTP status the ops report. */
export class PoolBackendError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    readonly code: "not_found" | "invalid_input",
  ) {
    super(message);
    this.name = "PoolBackendError";
  }
}

/** The run token lives this long past the step timeout (D: step timeout plus a margin). */
export const RUN_TOKEN_TTL_MS = 6 * 60 * 60_000;

export interface InternalPoolOptions {
  /** The data root; accounts live in `<root>/gateway/`. */
  root: string;
  now?: () => number;
  strategy?: Strategy;
  /** Tests only: a fake upstream. */
  upstreamOrigin?: string;
  env?: GatewayServerOptions["env"];
}

interface Running {
  pool: Pool;
  tokens: TokenStore;
  server: GatewayServer | null;
  url: string | null;
}

/**
 * boof's own pool: Anthropic API keys in `<data>/gateway/accounts.json`, served by a loopback
 * `GatewayServer` that starts on the first routed run and stops with {@link stop}. Keys are
 * write-only: nothing here returns one.
 */
export class InternalPoolBackend implements PoolBackend {
  private running?: Promise<Running>;
  private starting?: Promise<string>;

  constructor(private readonly opts: InternalPoolOptions) {}

  private open(): Promise<Running> {
    this.running ??= (async () => {
      const store = new AccountsStore(join(this.opts.root, "gateway"));
      const pool = await Pool.open({
        store,
        ...(this.opts.now ? { now: this.opts.now } : {}),
        ...(this.opts.strategy ? { strategy: this.opts.strategy } : {}),
      });
      return { pool, tokens: new TokenStore({ now: this.opts.now }), server: null, url: null };
    })();
    this.running.catch(() => (this.running = undefined));
    return this.running;
  }

  async pool(): Promise<Pool> {
    return (await this.open()).pool;
  }

  async setStrategy(strategy: Strategy | undefined): Promise<void> {
    (await this.open()).pool.setStrategy(strategy ?? "ordered");
  }

  async health(): Promise<PoolStatus> {
    return (await this.pool()).status();
  }

  async accounts(): Promise<AccountSummary[]> {
    return (await this.pool()).accountList().map(toSummary);
  }

  async add(input: { name: string; apiKey: string; priority?: number }): Promise<AccountSummary> {
    const pool = await this.pool();
    try {
      return toSummary(await pool.add(input));
    } catch (err) {
      // Validation messages name the problem, never the key.
      throw new PoolBackendError(
        err instanceof Error ? err.message : "invalid account",
        400,
        "invalid_input",
      );
    }
  }

  /** The better-ccflare database an import reads when no path is given. */
  static defaultCcflareDb = (): string => defaultCcflareDb();

  /** How many API-key accounts a better-ccflare database offers, and how many it leaves. Counts only. */
  async previewCcflare(path?: string): Promise<{ importable: number; skipped: number }> {
    return this.ccflare(() => summariseCcflare(path ?? defaultCcflareDb()));
  }

  /** One-time import of the API-key accounts of a better-ccflare database (read-only). No key is returned. */
  async importFromCcflare(path?: string): Promise<CcflareImportResult> {
    const pool = await this.pool();
    return this.ccflare(() => importCcflare(path ?? defaultCcflareDb(), (a) => pool.add(a)));
  }

  private async ccflare<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CcflareImportError)
        throw new PoolBackendError(err.message, 400, "invalid_input");
      throw err;
    }
  }

  async remove(id: string): Promise<void> {
    if (!(await (await this.pool()).remove(id))) throw notFound(id);
  }

  async pause(id: string): Promise<void> {
    if (!(await (await this.pool()).pause(id))) throw notFound(id);
  }

  async resume(id: string): Promise<void> {
    if (!(await (await this.pool()).resume(id))) throw notFound(id);
  }

  async setPriority(id: string, priority: number): Promise<void> {
    const pool = await this.pool();
    try {
      if (!(await pool.setPriority(id, priority))) throw notFound(id);
    } catch (err) {
      if (err instanceof PoolBackendError) throw err;
      throw new PoolBackendError(
        err instanceof Error ? err.message : "invalid priority",
        400,
        "invalid_input",
      );
    }
  }

  /** Every account is an API-key account by construction, so any account makes claude-agent eligible. */
  async accountCount(): Promise<number> {
    return (await this.pool()).accountList().length;
  }

  /**
   * Start the listener if needed and mint a token for one run. The token is the child's only
   * credential; revoke it with {@link releaseRun}. The account keys never leave this object.
   */
  async childGateway(input: {
    runId: string;
    projectId?: string | null;
    ttlMs?: number;
  }): Promise<ChildGateway> {
    const run = await this.open();
    const url = await this.start(run);
    const apiKey = run.tokens.mint({
      runId: input.runId,
      projectId: input.projectId ?? null,
      ttlMs: input.ttlMs ?? RUN_TOKEN_TTL_MS,
    });
    return { url, apiKey };
  }

  private start(run: Running): Promise<string> {
    if (run.url) return Promise.resolve(run.url);
    this.starting ??= (async () => {
      const server = new GatewayServer({
        pool: run.pool,
        tokens: run.tokens,
        ...(this.opts.now ? { now: this.opts.now } : {}),
        ...(this.opts.upstreamOrigin ? { upstreamOrigin: this.opts.upstreamOrigin } : {}),
        ...(this.opts.env ? { env: this.opts.env } : {}),
        log: (e) => {
          if (e.event === "error") console.error(`gateway: ${e.message ?? "error"}`);
        },
      });
      const { url } = await server.start();
      run.server = server;
      run.url = url;
      return url;
    })();
    this.starting.catch(() => (this.starting = undefined));
    return this.starting;
  }

  /** The loopback port while the listener runs (for the sandbox policy and tests), else null. */
  async port(): Promise<number | null> {
    const run = await this.open();
    return run.url ? Number(new URL(run.url).port) : null;
  }

  /** Revoke every token of a run. A second request with one gets 401. */
  async releaseRun(runId: string): Promise<void> {
    if (!this.running) return;
    (await this.running).tokens.revokeRun(runId);
  }

  async stop(): Promise<void> {
    const running = this.running;
    this.running = undefined;
    this.starting = undefined;
    if (!running) return;
    const run = await running;
    await run.server?.stop();
    await run.pool.flush().catch(() => {});
  }
}

const notFound = (id: string) => new PoolBackendError(`No account ${id}`, 404, "not_found");

function toSummary(a: InternalAccountSummary): AccountSummary {
  return { ...a };
}

const shared = new Map<string, InternalPoolBackend>();

/**
 * One backend per data root in this process, so the runner that starts the loopback listener
 * and the ops that add, pause or remove accounts see the same pool.
 */
export function sharedInternalBackend(
  root: string,
  opts: Omit<InternalPoolOptions, "root"> = {},
): InternalPoolBackend {
  let b = shared.get(root);
  if (!b) {
    b = new InternalPoolBackend({ root, ...opts });
    shared.set(root, b);
  }
  return b;
}

/** Stop and forget the shared backend of a data root (server shutdown, tests). */
export async function stopSharedInternalBackend(root: string): Promise<void> {
  const b = shared.get(root);
  shared.delete(root);
  await b?.stop();
}
