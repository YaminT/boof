import { createServer as createHttpsServer } from "node:https";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import {
  AuthStore,
  BrowserSessionStore,
  browserSessionCookieName,
  dataRootPaths,
  UnsafeBrowserSessionPathError,
  ExternalRunStore,
  dataRootAccessNotice,
  migrateDataRoot,
  securitySettings,
  tightenDataRoot,
  type Settings,
  type ToolCatalog,
  type ConciergeAgent,
  reservedIdWarning,
} from "@boof/heart";
import { createApp } from "./app.js";
import { isLoopbackHost } from "./middleware/auth.js";
import { pruneAudit } from "./middleware/audit.js";
import { IdempotencyStore, TaskService } from "../api/index.js";
import { DataWatcher } from "./watch.js";
import { createSelfUrlCheck } from "./self-url.js";
import { N8nClient } from "../n8n/client.js";
import { N8nWatcher } from "../n8n/watcher.js";
import { runDispatcherWhileHolding, WebhookDispatcher } from "./webhooks.js";

export interface StartServerOptions {
  root: string;
  /** Client ids treated as the local operator for project registration (the desktop's own key). */
  operatorClients?: ReadonlySet<string>;
  port?: number;
  /** Bind address. Default 127.0.0.1; anything non-loopback requires `auth.mode = "required"`. */
  host?: string;
  uiDir?: string;
  /** Extra Host header names accepted besides loopback. */
  allowedHosts?: string[];
  /** The tools. Required: the composition root (bin, desktop) builds the registry; Heart never does. */
  catalog: ToolCatalog;
  /** Assistant implementation supplied by the composition root; absent in standalone server mode. */
  conciergeAgent?: ConciergeAgent;
  /** PEM file paths; when both are set the server speaks HTTPS. */
  tlsCert?: string;
  tlsKey?: string;
  /** Version reported by /healthz. */
  version?: string;
  /** Whether the runner loop runs in this process (reported by /healthz). */
  runnerRunning?: () => boolean;
  /** Receives non-fatal startup warnings (default: console.warn). */
  warn?: (message: string) => void;
  /** How often the webhook dispatcher looks for events (default 1000 ms). */
  webhookIntervalMs?: number;
  /** How often a server that is not delivering retries the dispatcher lock (default 5000 ms). */
  webhookLockRetryMs?: number;
}

export interface RunningServer {
  server: ServerType;
  watcher: DataWatcher;
  webhooks: WebhookDispatcher;
  service: TaskService;
  port: number;
  /** True for a URL that points at this server (its port on one of its names). */
  isSelfUrl: (url: URL) => boolean;
  stop: () => Promise<void>;
}

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/**
 * Refuse to expose the API beyond loopback unless authentication is mandatory
 * and at least one usable client exists.
 */
export async function assertBindAllowed(
  host: string,
  settings: Settings,
  store: AuthStore,
): Promise<void> {
  if (isLoopbackHost(host)) return;
  const sec = securitySettings(settings);
  if (sec.auth.mode !== "required") {
    throw new Error(
      `refusing to bind ${host}: set security.auth.mode = "required" and create a client with "boof-runner auth add"`,
    );
  }
  if (!(await store.hasActiveClient())) {
    throw new Error(
      `refusing to bind ${host}: no active API client exists; create one with "boof-runner auth add"`,
    );
  }
}

/**
 * Start the web server. Uses @hono/node-server, which runs on both Node and
 * Bun (node:http compatible), satisfying the dual-runtime requirement.
 */
export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  // Bring a v1 data root to v2 before any store opens (also scaffolds a fresh root).
  const migration = await migrateDataRoot(opts.root);
  const tightened = await tightenDataRoot(opts.root);
  const accessNotice = dataRootAccessNotice(opts.root, tightened);
  if (accessNotice) warn(accessNotice);
  else if (
    !tightened.changed &&
    ["not-owner", "home-or-root", "chmod-failed"].includes(tightened.reason) &&
    !tightened.unsafeParent
  ) {
    await warnIfDataRootOpen(opts.root, warn);
  }
  if (tightened.unsafeParent)
    warn(`warning: ${tightened.unsafeParent.message}; the server refuses key checks until then`);
  if (migration.kind === "migrated")
    warn(`migrated data root ${opts.root} to v2 (see migration-v2.log)`);
  const authStore = new AuthStore(opts.root);
  const service = new TaskService(opts.root, opts.catalog, {
    conciergeAgent: opts.conciergeAgent,
    authStore,
  });
  const settings = await service.loadSettings(); // scaffolds settings.json if missing
  const host = opts.host ?? "127.0.0.1";
  const sec = securitySettings(settings);
  await assertBindAllowed(host, settings, authStore);
  let tls: { cert: Buffer; key: Buffer } | undefined;
  if (opts.tlsCert || opts.tlsKey) {
    if (!opts.tlsCert || !opts.tlsKey) throw new Error("TLS needs both a certificate and a key");
    tls = { cert: await readFile(opts.tlsCert), key: await readFile(opts.tlsKey) };
  }
  const loopback = isLoopbackHost(host);
  if (!loopback && !tls) {
    warn(
      `warning: binding ${host} without TLS; API keys travel in clear text. Use --tls-cert/--tls-key, Tailscale or a reverse proxy.`,
    );
  }
  // The data root holds keys' hashes and prompts; only nag once that matters.
  const reserved = reservedIdWarning(await authStore.list().catch(() => []));
  if (reserved) warn(reserved);
  await pruneAudit(opts.root, sec.audit.retentionDays).catch(() => []);
  await new IdempotencyStore(opts.root).prune().catch(() => 0);

  const watcher = new DataWatcher(opts.root);
  watcher.start();

  const allowedHosts = [...(opts.allowedHosts ?? [])];
  if (!loopback && !WILDCARD_HOSTS.has(host)) allowedHosts.push(host);

  // A webhook must not call back into this server: remember the names and port it answers to.
  let boundPort = opts.port ?? 4319;
  const isSelfUrl = createSelfUrlCheck({ port: () => boundPort, bindHost: host, allowedHosts });

  // Expired external-step run records and results: pruned at start and hourly.
  const externalRuns = new ExternalRunStore(opts.root);
  await externalRuns.prune().catch(() => 0);
  const pruneTimer = setInterval(() => void externalRuns.prune().catch(() => 0), 3600_000);
  pruneTimer.unref();

  // A new epoch on every start. Cookies minted by the previous process no longer verify.
  // An unsafe data root already refuses session checks; do not fail startup over it.
  const browserSessions = new BrowserSessionStore(opts.root);
  try {
    await browserSessions.beginEpoch();
  } catch (error) {
    if (!(error instanceof UnsafeBrowserSessionPathError)) throw error;
    warn(`warning: could not rotate browser sessions (${error.message})`);
  }

  const app = createApp({
    service,
    externalRuns,
    watcher,
    uiDir: opts.uiDir,
    allowedHosts,
    authStore,
    browserSessions,
    sessionCookieName: () => browserSessionCookieName(boundPort),
    linkPort: () => boundPort,
    operatorClients: opts.operatorClients,
    isSelfUrl,
    version: opts.version,
    runnerRunning: opts.runnerRunning,
    tls: tls !== undefined,
  });

  const server = await new Promise<ServerType>((resolve, reject) => {
    const base = { fetch: app.fetch, hostname: host, port: opts.port ?? 4319 };
    const listening = () => resolve(s);
    const s = tls
      ? serve(
          {
            ...base,
            createServer: createHttpsServer as never,
            serverOptions: { key: tls.key, cert: tls.cert } as never,
          },
          listening,
        )
      : serve(base, listening);
    s.once("error", reject);
  }).catch(async (err: unknown) => {
    clearInterval(pruneTimer);
    await watcher.stop().catch(() => {});
    throw err;
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 4319);
  boundPort = port;

  // Webhooks are delivered by one server per data root (headless run/scan processes do not
  // deliver): the one holding `webhooks/.dispatcher.lock`. A second server waits and takes over
  // when the first exits or dies. Independent of the runner guard: a lone --no-runner server
  // still delivers.
  const webhooks = new WebhookDispatcher({
    root: opts.root,
    service,
    authStore,
    intervalMs: opts.webhookIntervalMs,
  });
  // The n8n edit watcher polls only where webhooks are delivered, so one server per data root
  // does it; it stops before the lock is released.
  const n8nWatcher = new N8nWatcher({
    root: opts.root,
    service,
    client: new N8nClient({ root: opts.root, isSelfUrl }),
  });
  const dispatcherGate = runDispatcherWhileHolding(
    {
      start: () => {
        webhooks.start();
        n8nWatcher.start();
      },
      stop: async () => {
        await n8nWatcher.stop();
        await webhooks.stop();
      },
    },
    join(dataRootPaths(opts.root).webhooks, ".dispatcher.lock"),
    { retryMs: opts.webhookLockRetryMs },
  );
  await dispatcherGate.ready;

  return {
    server,
    watcher,
    webhooks,
    service,
    port,
    isSelfUrl,
    stop: async () => {
      clearInterval(pruneTimer);
      await dispatcherGate.stop();
      await watcher.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Long-lived SSE streams and keep-alive sockets would hold close() open forever.
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
    },
  };
}

/** Retain the existing warning when the root could not safely be tightened. */
async function warnIfDataRootOpen(root: string, warn: (m: string) => void): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const mode = (await stat(root)).mode & 0o777;
    if (mode & 0o077) {
      warn(
        `warning: data root ${root} is accessible to other users (mode ${mode.toString(8)}); run: chmod 700 "${root}"`,
      );
    }
  } catch {
    /* ignore */
  }
}
