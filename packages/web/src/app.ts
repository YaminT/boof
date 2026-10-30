import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import {
  AuthStore,
  authorize,
  authorizeProject,
  isKebabId,
  MAX_ATTACHMENT_BYTES,
  type Principal,
} from "@boof-runner/shared";
import {
  buildOpenApi,
  IdempotencyStore,
  OpError,
  registry,
  toOpError,
  type AnyOperation,
  type ResolveHost,
  type TaskService,
} from "@boof-runner/api";
import { hostGuard } from "./middleware/host-guard.js";
import { originGuard } from "./middleware/origin-guard.js";
import {
  createAuthenticator,
  defaultPeerAddress,
  requireScope,
  type PeerAddressResolver,
} from "./middleware/auth.js";
import { rateLimit, unauthenticatedRateLimit } from "./middleware/rate-limit.js";
import { audit } from "./middleware/audit.js";
import { securityConfigReader } from "./security-config.js";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { DataWatcher } from "./watch.js";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  liveCursor,
  readableScopes,
  readFeed,
  type FeedCursor,
} from "./events.js";
import { LEGACY_SUNSET, mountOps } from "./rest.js";
import { mcpRoute } from "./mcp-route.js";
import { HARNESS_MD } from "./generated/harness.js";

export interface AppDeps {
  service: TaskService;
  watcher?: DataWatcher;
  /** Absolute path to the built UI directory (index.html + assets), if any. */
  uiDir?: string;
  /** Extra Host header names accepted besides loopback (DNS-rebinding guard). */
  allowedHosts?: string[];
  /** Client registry; defaults to <data>/auth/clients.json under the service root. */
  authStore?: AuthStore;
  /** Resolves the TCP peer address (loopback detection). Default: the socket's remote address. */
  peerAddress?: PeerAddressResolver;
  /** True when a URL points at this server itself (webhook targets must not). */
  isSelfUrl?: (url: URL) => boolean;
  /** DNS for the webhook target check; tests inject a fake. */
  resolveHost?: ResolveHost;
  /** Version reported by /healthz. */
  version?: string;
  /** Whether the background runner loop runs in this process (reported by /healthz). */
  runnerRunning?: () => boolean;
  /** Clock override for tests (rate limit, client cache, audit). */
  now?: () => number;
  /** True when this process terminates TLS itself (--tls-cert): the only case boof sends Strict-Transport-Security. */
  tls?: boolean;
}

/** The public documents an agent or another origin may read; they get CORP cross-origin. */
const PUBLIC_DOCS = new Set(["/harness.md", "/harness.txt", "/llms.txt"]);
/** No includeSubDomains: this header pins one host, not every subdomain of the site. */
const HSTS = "max-age=15552000";

const MARKDOWN = "text/markdown; charset=utf-8";
const PLAIN = "text/plain; charset=utf-8";

/** llms.txt (llmstxt.org): what boof is and where an agent starts. */
const LLMS_TXT = `# boof-runner

> boof-runner is a local task runner for coding agents. Register a git repository as a project, submit plans of goals or single prompts, and boof runs them through a planner, developer, observer and reviewer pipeline in git worktrees. You operate it over a REST API or MCP with a host URL and an API key.

## Docs

- [Harness guide](harness.txt): the complete guide for an AI agent: connection, concepts, every REST operation, workflows
- [OpenAPI](api/v1/openapi.json): the machine-readable REST contract (needs an API key)
`;

/**
 * The path prefix a reverse proxy mounted boof under (`X-Forwarded-Prefix: /boof`), or "" at the
 * root. Only a clean absolute path is accepted; it is used for server-emitted URLs.
 */
function publicPrefix(c: Context): string {
  const raw = c.req.header("x-forwarded-prefix") ?? "";
  if (!/^\/[A-Za-z0-9._~\-\/]*$/.test(raw) || raw.includes("..")) return "";
  return raw.replace(/\/+$/, "");
}

const JSON_BODY_LIMIT = 1_000_000;
/** Open event streams one principal may hold; the next one answers 429 rate_limited. */
const MAX_EVENT_STREAMS_PER_PRINCIPAL = 16;
const ATTACHMENT_BODY_LIMIT = MAX_ATTACHMENT_BYTES + 64 * 1024;

/**
 * Build the Hono app: a file-backed REST API plus an SSE stream and (optionally)
 * the static UI. Authentication and authorization live in middleware/auth.ts:
 * loopback peers are trusted under `local-trust`, everyone else needs a bearer key.
 */
export function createApp(deps: AppDeps): Hono {
  const { service } = deps;
  const app = new Hono();

  const security = securityConfigReader(service);
  const authStore = deps.authStore ?? new AuthStore(service.root, deps.now);
  const peerAddress = deps.peerAddress ?? defaultPeerAddress;

  app.use(
    "*",
    hostGuard(async () => [...(deps.allowedHosts ?? []), ...(await security()).allowedHosts]),
  );
  // secureHeaders sets its headers after next(), so a route cannot override them: the public
  // docs get their own configuration. HSTS is added only when boof itself terminated TLS and no
  // proxy says it did (X-Forwarded-Proto); behind a proxy, HSTS belongs to the proxy.
  const apiHeaders = secureHeaders({ strictTransportSecurity: false });
  const docsHeaders = secureHeaders({
    strictTransportSecurity: false,
    crossOriginResourcePolicy: "cross-origin",
  });
  app.use("*", (c, next) => (PUBLIC_DOCS.has(c.req.path) ? docsHeaders : apiHeaders)(c, next));
  app.use("*", async (c, next) => {
    await next();
    // A client that sends X-Forwarded-Proto itself can only suppress HSTS for its own response; accepted.
    if (deps.tls && c.req.header("x-forwarded-proto") === undefined)
      c.res.headers.set("Strict-Transport-Security", HSTS);
  });
  // Public liveness probe for systemd, load balancers and uptime monitors. Carries no
  // project or task data; it sits behind the Host guard like the docs below.
  const startedAt = (deps.now ?? Date.now)();
  const HEALTH_CACHE_MS = 5_000;
  let health: { at: number; enabled: boolean } | undefined;
  app.get("/healthz", async (c) => {
    const now = deps.now ?? Date.now;
    if (!health || now() - health.at >= HEALTH_CACHE_MS) {
      let enabled = false;
      try {
        enabled = (await service.loadSettings()).runner.enabled;
      } catch {
        /* unreadable settings: report disabled, the process is still alive */
      }
      health = { at: now(), enabled };
    }
    const { enabled } = health;
    return c.json(
      {
        ok: true,
        version: deps.version ?? "unknown",
        uptimeSeconds: Math.max(0, Math.floor(((deps.now ?? Date.now)() - startedAt) / 1000)),
        runner: { enabled, running: deps.runnerRunning?.() ?? false },
      },
      200,
      { "Cache-Control": "no-store" },
    );
  });
  // Public, unauthenticated docs for AI agents. They hold no secrets and sit behind the Host
  // guard only; the text is `docs/harness.md` embedded at build time (see generated/harness.ts).
  app.get("/harness.md", (c) => c.body(HARNESS_MD, 200, { "Content-Type": MARKDOWN }));
  app.get("/harness.txt", (c) => c.body(HARNESS_MD, 200, { "Content-Type": PLAIN }));
  app.get("/llms.txt", (c) => c.body(LLMS_TXT, 200, { "Content-Type": PLAIN }));
  // Outermost on /api so rejected requests (401/403/429) are audited too.
  // `/mcp` (the MCP endpoint) runs through the same chain as `/api/*`.
  const guarded = ["/api/*", "/mcp"];
  const auditor = audit({ root: service.root, security, now: deps.now });
  for (const path of guarded) app.use(path, auditor);

  const tooLarge = (c: Context) =>
    c.json({ error: { code: "payload_too_large", message: "Request body too large" } }, 413);
  const jsonLimit = bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: tooLarge });
  const attachmentLimit = bodyLimit({ maxSize: ATTACHMENT_BODY_LIMIT, onError: tooLarge });
  app.use("/mcp", jsonLimit);
  app.use("/api/*", (c, next) =>
    c.req.method === "POST" &&
    /^\/api\/(v1\/)?(projects\/[^/]+\/)?tasks\/[^/]+\/attachments\/?$/.test(c.req.path)
      ? attachmentLimit(c, next)
      : jsonLimit(c, next),
  );
  const origins = originGuard(async () => [
    ...(deps.allowedHosts ?? []),
    ...(await security()).allowedHosts,
  ]);
  for (const path of guarded) app.use(path, origins);
  const auth = createAuthenticator({ store: authStore, security, peerAddress, now: deps.now });
  const limiter = rateLimit({ security, now: deps.now });
  // Before authenticate, so failed key guesses are throttled before any key is checked; after the
  // Origin guard, so cross-site rejections do not spend a client's bucket.
  const unauthenticated = unauthenticatedRateLimit({ security, peerAddress, now: deps.now });
  for (const path of guarded) {
    app.use(path, unauthenticated);
    app.use(path, auth.middleware);
    app.use(path, limiter);
  }

  app.onError((err, c) => {
    const e = toOpError(err);
    return c.json(e.toBody(), e.status as 400);
  });

  const api = new Hono();

  // The unversioned routes are deprecated: say so on every response.
  app.use("/api/*", async (c, next) => {
    if (!c.req.path.startsWith("/api/v1/") && c.req.path !== "/api/v1") {
      c.header("Deprecation", "true");
      c.header("Sunset", LEGACY_SUNSET);
      if (!c.req.path.startsWith("/api/events")) {
        c.header(
          "Link",
          `<${publicPrefix(c)}${c.req.path.replace(/^\/api\//, "/api/v1/")}>; rel="successor-version"`,
        );
      }
    }
    await next();
  });

  const idempotency = new IdempotencyStore(service.root);
  const restDeps = {
    service,
    authStore,
    idempotency,
    isSelfUrl: deps.isSelfUrl,
    resolveHost: deps.resolveHost,
  };
  // The contract, generated once from the registry. Any authenticated principal may read it.
  const openapiByPrefix = new Map<string, string>();
  api.get("/v1/openapi.json", (c) => {
    const prefix = publicPrefix(c);
    let openapi = openapiByPrefix.get(prefix);
    if (!openapi) {
      openapi = JSON.stringify(buildOpenApi(registry, { basePath: `${prefix}/api/v1` }));
      openapiByPrefix.set(prefix, openapi);
    }
    return c.body(openapi, 200, { "Content-Type": "application/json" });
  });
  mountOps(api, registry as readonly AnyOperation[], restDeps, { prefix: "/v1", legacy: false });
  mountOps(api, registry as readonly AnyOperation[], restDeps, { prefix: "", legacy: true });

  const who = (c: Context) => c.get("principal");

  // Open event streams per principal: each holds a watcher subscription and two timers.
  const openStreams = new Map<string, number>();
  const acquireStream = (c: Context, id: string): void => {
    const n = openStreams.get(id) ?? 0;
    if (n >= MAX_EVENT_STREAMS_PER_PRINCIPAL) {
      c.header("Retry-After", "5");
      throw new OpError(
        429,
        `Too many open event streams for this principal (max ${MAX_EVENT_STREAMS_PER_PRINCIPAL})`,
        "rate_limited",
        { retryAfter: 5 },
      );
    }
    openStreams.set(id, n + 1);
  };
  const releaseStream = (id: string): void => {
    const n = (openStreams.get(id) ?? 1) - 1;
    if (n <= 0) openStreams.delete(id);
    else openStreams.set(id, n);
  };
  // The key (or auth mode) may have changed since the stream opened: same principal, still allowed.
  const resolveSame = async (c: Context, current: Principal): Promise<Principal | null> => {
    const r = await auth.resolve(c);
    if (!r.ok || r.principal.id !== current.id || !authorize(r.principal, "tasks:read"))
      return null;
    return r.principal;
  };
  const UNAUTHORIZED = JSON.stringify({
    message: "API key revoked, expired or no longer authorized",
  });

  // --- SSE ---
  // v1: typed events from the events files, replayable by cursor (see events.ts).
  api.get("/v1/events", requireScope("tasks:read"), async (c) => {
    let principal = who(c);
    const project = c.req.query("project");
    if (project !== undefined) {
      if (!isKebabId(project)) throw new OpError(400, "Invalid project id", "invalid_input");
      if (!authorizeProject(principal, project)) {
        throw new OpError(
          403,
          `This client may not access project: ${project}`,
          "forbidden_project",
          { project },
        );
      }
      await service.requireProject(project);
    }
    const sinceText = c.req.header("Last-Event-ID") ?? c.req.query("since");
    const scopes = () => readableScopes(service, principal, project);
    let cursor: FeedCursor;
    if (sinceText === undefined || sinceText === "")
      cursor = await liveCursor(service.root, await scopes());
    else if (sinceText === "start") cursor = {};
    else {
      const decoded = decodeFeedCursor(sinceText);
      if (!decoded)
        throw new OpError(400, "Invalid since cursor", "invalid_input", [
          { path: "since", message: "Invalid cursor" },
        ]);
      cursor = decoded;
    }
    c.header("X-Accel-Buffering", "no"); // nginx: never buffer the event stream
    const streamId = principal.id;
    acquireStream(c, streamId);
    return streamSSE(c, async (stream) => {
      let ended = false;
      let unsub = () => {};
      let poll: ReturnType<typeof setInterval> | undefined;
      let beat: ReturnType<typeof setInterval> | undefined;
      let wake = () => {};
      const finish = () => {
        if (ended) return;
        ended = true;
        unsub();
        clearInterval(poll);
        clearInterval(beat);
        releaseStream(streamId);
        wake();
      };
      stream.onAbort(finish);
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ cursor: encodeFeedCursor(cursor) }),
      });
      let running: Promise<void> | null = null;
      let again = false;
      const readAll = async () => {
        do {
          again = false;
          for (;;) {
            const batch = await readFeed(service.root, await scopes(), cursor, 200);
            if (batch.length === 0) break;
            for (const e of batch) {
              await stream.writeSSE({
                event: e.event.type,
                id: e.cursor,
                data: JSON.stringify(e.event),
              });
            }
            cursor = decodeFeedCursor(batch[batch.length - 1].cursor) ?? cursor;
          }
        } while (again);
      };
      // False once the stream is over: the key stopped working (the unauthorized event is sent).
      // A call during a running drain waits for it, so a `changed` hint never overtakes events.
      const drain = async (): Promise<boolean> => {
        if (ended) return false;
        const fresh = await resolveSame(c, principal);
        if (!fresh) {
          await stream.writeSSE({ event: "unauthorized", data: UNAUTHORIZED }).catch(() => {});
          finish();
          return false;
        }
        principal = fresh;
        if (running) {
          again = true;
          await running;
        } else {
          running = readAll().finally(() => (running = null));
          await running;
        }
        return !ended;
      };
      // Subscribe before the first drain, so a change during the replay is not missed.
      if (deps.watcher) {
        unsub = deps.watcher.subscribe((_event, data) => {
          // Typed events first (replayable); then a `changed` hint for file changes that are not
          // events (a streaming log, an edited prompt). Hints are never replayed.
          if (data.project && !authorizeProject(principal, data.project)) return;
          if (project && data.project && data.project !== project) return;
          void drain()
            .then(async (alive) => {
              if (alive) await stream.writeSSE({ event: "changed", data: JSON.stringify(data) });
            })
            .catch(() => {});
        });
        poll = setInterval(() => void drain().catch(() => {}), 2000);
        beat = setInterval(() => void stream.write(": keepalive\n\n").catch(() => {}), 15000);
      }
      try {
        await drain();
      } catch (err) {
        finish();
        throw err;
      }
      if (ended || !deps.watcher) {
        finish(); // no live source (tests): replay only
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    });
  });

  // Deprecated: untyped `changed` pings (the old UI refetches on each).
  api.get("/events", requireScope("tasks:read"), (c) => {
    const streamId = who(c).id;
    acquireStream(c, streamId);
    return streamSSE(c, async (stream) => {
      let principal = who(c);
      let ended = false;
      let unsub = () => {};
      let wake = () => {};
      const finish = () => {
        if (ended) return;
        ended = true;
        unsub();
        releaseStream(streamId);
        wake();
      };
      stream.onAbort(finish);
      await stream.writeSSE({ event: "ready", data: "connected" });
      if (!deps.watcher) {
        // No watcher (e.g. tests): end after the greeting.
        finish();
        return;
      }
      unsub = deps.watcher.subscribe((event, data) => {
        void (async () => {
          if (ended) return;
          const fresh = await resolveSame(c, principal);
          if (!fresh) {
            await stream.writeSSE({ event: "unauthorized", data: UNAUTHORIZED }).catch(() => {});
            finish();
            return;
          }
          principal = fresh;
          // A restricted client never hears about projects it may not read.
          if (data.project && !authorizeProject(principal, data.project)) return;
          await stream.writeSSE({ event, data: JSON.stringify(data) });
        })().catch(() => {});
      });
      // Keep the connection open until the client disconnects or the key stops working.
      if (!ended)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    });
  });

  app.all("/mcp", mcpRoute({ service, authStore }));

  app.route("/api", api);
  app.all("/api/*", (c) =>
    c.json(
      { error: { code: "not_found", message: `No such route: ${c.req.method} ${c.req.path}` } },
      404,
    ),
  );

  // --- Static UI (optional) ---
  if (deps.uiDir && existsSync(deps.uiDir)) {
    app.use("/*", serveStatic({ root: deps.uiDir }));
    app.get("/*", serveStatic({ path: "index.html", root: deps.uiDir }));
  } else {
    app.get("/", (c) => c.text("Boof Runner Agent Task Runner — UI not built. API at api/v1/*"));
  }

  return app;
}
