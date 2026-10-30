import { networkInterfaces } from "node:os";
import { createServer as createHttpsServer } from "node:https";
import { readFile, stat } from "node:fs/promises";
import { serve, type ServerType } from "@hono/node-server";
import { ToolRegistry } from "@boof-runner/runner";
import { AuthStore, migrateDataRoot, securitySettings, type Settings } from "@boof-runner/shared";
import { createApp } from "./app.js";
import { isLoopbackHost } from "./middleware/auth.js";
import { pruneAudit } from "./middleware/audit.js";
import { IdempotencyStore, TaskService } from "@boof-runner/api";
import { DataWatcher } from "./watch.js";
import { hostnameOf } from "./middleware/host-guard.js";
import { WebhookDispatcher } from "./webhooks.js";

export interface StartServerOptions {
  root: string;
  port?: number;
  /** Bind address. Default 127.0.0.1; anything non-loopback requires `auth.mode = "required"`. */
  host?: string;
  uiDir?: string;
  /** Extra Host header names accepted besides loopback. */
  allowedHosts?: string[];
  registry?: ToolRegistry;
  /** PEM file paths; when both are set the server speaks HTTPS. */
  tlsCert?: string;
  tlsKey?: string;
  /** Version reported by /healthz. */
  version?: string;
  /** Whether the runner loop runs in this process (reported by /healthz). */
  runnerRunning?: () => boolean;
  /** Receives non-fatal startup warnings (default: console.warn). */
  warn?: (message: string) => void;
}

export interface RunningServer {
  server: ServerType;
  watcher: DataWatcher;
  webhooks: WebhookDispatcher;
  service: TaskService;
  port: number;
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
  if (migration.kind === "migrated")
    warn(`migrated data root ${opts.root} to v2 (see migration-v2.log)`);
  const service = new TaskService(opts.root, opts.registry ?? new ToolRegistry());
  const settings = await service.loadSettings(); // scaffolds settings.json if missing
  const host = opts.host ?? "127.0.0.1";
  const sec = securitySettings(settings);
  const authStore = new AuthStore(opts.root);

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
  if (!loopback || (await authStore.list().catch(() => [])).length > 0) {
    await warnIfDataRootOpen(opts.root, warn);
  }
  await pruneAudit(opts.root, sec.audit.retentionDays).catch(() => []);
  await new IdempotencyStore(opts.root).prune().catch(() => 0);

  const watcher = new DataWatcher(opts.root);
  watcher.start();

  const allowedHosts = [...(opts.allowedHosts ?? [])];
  if (!loopback && !WILDCARD_HOSTS.has(host)) allowedHosts.push(host);

  // A webhook must not call back into this server: remember the names and port it answers to.
  const selfNames = new Set(
    [
      "localhost",
      "127.0.0.1",
      "[::1]",
      "0.0.0.0",
      host.toLowerCase(),
      ...allowedHosts.map(hostnameOf),
    ].map((h) => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h)),
  );
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) selfNames.add(a.family === "IPv6" ? `[${a.address}]` : a.address);
  }
  let boundPort = opts.port ?? 4319;
  const isSelfUrl = (url: URL): boolean =>
    Number(url.port || (url.protocol === "https:" ? 443 : 80)) === boundPort &&
    selfNames.has(url.hostname.toLowerCase());

  const app = createApp({
    service,
    watcher,
    uiDir: opts.uiDir,
    allowedHosts,
    authStore,
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
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 4319);
  boundPort = port;

  // Webhooks are delivered by this process only (headless run/scan processes do not deliver).
  const webhooks = new WebhookDispatcher({ root: opts.root, service });
  webhooks.start();

  return {
    server,
    watcher,
    webhooks,
    service,
    port,
    stop: async () => {
      webhooks.stop();
      await watcher.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Long-lived SSE streams and keep-alive sockets would hold close() open forever.
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
    },
  };
}

/** Log a warning when the data root (which holds keys and prompts) is group/world accessible. */
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
