import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import {
  AuthStore,
  BrowserSessionStore,
  browserSessionCookieName,
  authorize,
  authorizeProject,
  isKebabId,
  MAX_ATTACHMENT_BYTES,
  BOOF_VERSION,
  ExternalRunStore,
  dismissUpdate,
  instanceProof,
  randomInstanceId,
  readUpdateCache,
  uiNotice,
  type BrowserSessionVerifier,
  type Principal,
} from "@boof/heart";
import {
  buildOpenApi,
  IdempotencyStore,
  OpError,
  registry,
  toOpError,
  type AnyOperation,
  type ResolveHost,
  type TaskService,
} from "../api/index.js";
import { hostGuard } from "./middleware/host-guard.js";
import { originGuard } from "./middleware/origin-guard.js";
import {
  createAuthenticator,
  defaultPeerAddress,
  hostPort,
  requireScope,
  type PeerAddressResolver,
} from "./middleware/auth.js";
import { rateLimit, unauthenticatedRateLimit } from "./middleware/rate-limit.js";
import { audit } from "./middleware/audit.js";
import { securityConfigReader } from "./security-config.js";
import { isUiPath, uiDocument } from "./ui-document.js";
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
import { conciergeMcpRoute } from "./concierge-mcp-route.js";
import { browserSignin } from "./browser-signin.js";
import { externalCallbackRoutes } from "./external-callback.js";
import { HARNESS_MD } from "./generated/harness.js";
import { ConciergeAskInputSchema } from "../api/ops/concierge.js";
import { ConciergeEventSchema } from "../api/schemas.js";
import { attachConcierge } from "../concierge/compose.js";

export interface AppDeps {
  service: TaskService;
  /** Client ids treated as the local operator for project registration (see `AuthenticateOptions`). */
  operatorClients?: ReadonlySet<string>;
  watcher?: DataWatcher;
  /** Absolute path to the built UI directory (index.html + assets), if any. */
  uiDir?: string;
  /** Extra Host header names accepted besides loopback (DNS-rebinding guard). */
  allowedHosts?: string[];
  /** Client registry; defaults to <data>/auth/clients.json under the service root. */
  authStore?: AuthStore;
  /** Resolves the TCP peer address (loopback detection). Default: the socket's remote address. */
  peerAddress?: PeerAddressResolver;
  browserSessions?: BrowserSessionVerifier;
  sessionCookieName?: (c: Context) => string;
  /** Port sign-in links are bound to. Default: the port in the request's Host header. */
  linkPort?: (c: Context) => number;
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
  /** Run records for external-step callbacks; defaults to a store on the service root (test seam). */
  externalRuns?: ExternalRunStore;
  /** True when this process terminates TLS itself (--tls-cert): the only case boof sends Strict-Transport-Security. */
  tls?: boolean;
  /**
   * Id of this process. Authenticated responses send it as `X-Boof-Instance`. `/healthz` never
   * sends the id; with `?nonce=` it sends `instanceProof` (HMAC). Tests pin the id.
   */
  instanceId?: string;
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
/**
 * How often a running assistant stream re-checks the key or browser session. Shorter than the
 * events stream's 2s poll so a revoke ends the body inside 2s even when it lands just after a tick.
 */
const CONCIERGE_AUTH_POLL_MS = 500;
const SIGNED_OUT_MESSAGE =
  'Signed out: this browser session ended. Run "boof-runner open" for a new sign-in link.';
const UNAUTHORIZED_MESSAGE = "API key revoked, expired or no longer authorized";
const ATTACHMENT_BODY_LIMIT = MAX_ATTACHMENT_BYTES + 64 * 1024;

/**
 * Build the Hono app: a file-backed REST API plus an SSE stream and (optionally)
 * the static UI. Authentication and authorization live in middleware/auth.ts:
 * loopback peers are trusted under `local-trust`, everyone else needs a bearer key.
 */
export function createApp(deps: AppDeps): Hono {
  const { service } = deps;
  // HTTP tests build a TaskService and pass it here. The server and the CLI attach explicitly.
  if (!service.hasConcierge()) attachConcierge(service);
  const instanceId =
    deps.instanceId && /^[0-9a-f]{64}$/.test(deps.instanceId)
      ? deps.instanceId
      : randomInstanceId();
  const app = new Hono();

  const security = securityConfigReader(service);
  const authStore = deps.authStore ?? new AuthStore(service.root, deps.now);
  const peerAddress = deps.peerAddress ?? defaultPeerAddress;
  const browserSessions = deps.browserSessions ?? new BrowserSessionStore(service.root);
  const sessionCookieName =
    deps.sessionCookieName ??
    ((c: Context) => browserSessionCookieName(hostPort(c.req.header("host"))));

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
    // Only a request that already authenticated may learn the id. A public probe gets a proof.
    if (c.get("principal")) c.res.headers.set("X-Boof-Instance", instanceId);
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
    const nonce = c.req.query("nonce") ?? "";
    const proof = nonce ? await instanceProof(instanceId, nonce) : undefined;
    return c.json(
      {
        ok: true,
        version: deps.version ?? "unknown",
        uptimeSeconds: Math.max(0, Math.floor(((deps.now ?? Date.now)() - startedAt) / 1000)),
        runner: { enabled, running: deps.runnerRunning?.() ?? false },
        ...(proof ? { instanceProof: proof } : {}),
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
  // n8n's callback: outside the API-key chain, authenticated by its per-run token only.
  app.route(
    "/callbacks",
    externalCallbackRoutes({
      root: service.root,
      runs: deps.externalRuns ?? new ExternalRunStore(service.root, deps.now),
      security,
      peerAddress,
      now: deps.now,
    }),
  );
  // The claude-code assistant's per-turn loopback MCP endpoint: outside the API-key chain,
  // authenticated by its per-turn bearer token only, and refusing every non-loopback peer.
  // It answers 404 while no turn is open, and its refusals are audited like the API's.
  app.use(
    "/mcp/concierge/*",
    audit({ root: service.root, security, now: deps.now }),
    async (c, next) => {
      if (service.concierge().bridge.active === 0)
        return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
      await next();
    },
  );
  app.all(
    "/mcp/concierge/:turnId",
    conciergeMcpRoute({ bridge: () => service.concierge().bridge, peerAddress }),
  );
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
  const auth = createAuthenticator({
    store: authStore,
    security,
    peerAddress,
    now: deps.now,
    operatorClients: deps.operatorClients,
    browserSessions,
    sessionCookieName,
  });
  const limiter = rateLimit({ security, now: deps.now });
  // Before authenticate, so failed authentications are counted per address; a request whose key
  // verifies is never limited. After the Origin guard, so cross-site rejections do not spend a
  // client's bucket.
  const unauthenticated = unauthenticatedRateLimit({ security, peerAddress, now: deps.now });
  for (const path of guarded) {
    app.use(path, unauthenticated);
    app.use(path, auth.middleware);
    app.use(path, limiter);
  }

  // Sign-in is deliberately concealed outside the owner's local-trust browser context.
  app.use("/auth/browser", auditor);
  app.use("/auth/browser", unauthenticated);
  app.get(
    "/auth/browser",
    browserSignin({
      security,
      peerAddress,
      sessions: browserSessions,
      sessionCookieName,
      ...(deps.linkPort ? { linkPort: deps.linkPort } : {}),
    }),
  );

  app.onError((err, c) => {
    const e = toOpError(err);
    // An aborted request has no client to receive an error body (and 499 is not public API data).
    if (e.status === 499) return c.body(null, 499 as 400);
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

  // Not a registry operation: a release notice is not an agent tool. GET only reads the cache.
  // POST hides one version in the UI. Neither route asks GitHub.
  const releaseVersion = () => deps.version ?? BOOF_VERSION;
  api.get("/v1/updates", async (c) => {
    const cache = await readUpdateCache(service.root);
    return c.json({ update: uiNotice(releaseVersion(), cache) });
  });
  // The dismissal hides the notice for every client, so it needs the settings:write scope and a
  // client that is not limited to some projects (the owner's session, or an operator key).
  api.post("/v1/updates/dismiss", requireScope("settings:write"), async (c) => {
    if (who(c).projects !== "*") {
      throw new OpError(
        403,
        "Dismissing the update notice needs a client that may access every project",
        "forbidden_project",
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new OpError(400, "Request body must be valid JSON", "invalid_input");
    }
    const version =
      body && typeof body === "object" ? (body as { version?: unknown }).version : undefined;
    if (typeof version !== "string" || !/^[0-9A-Za-z.+-]{1,64}$/.test(version))
      throw new OpError(400, "version is required", "invalid_input");
    await dismissUpdate(service.root, version);
    const cache = await readUpdateCache(service.root);
    return c.json({ update: uiNotice(releaseVersion(), cache) });
  });

  const streamConcierge = async (c: Context) => {
    const principal = who(c);
    const projectId = c.req.param("projectId") ?? "";
    if (!authorizeProject(principal, projectId)) {
      throw new OpError(
        403,
        `This client may not access project: ${projectId}`,
        "forbidden_project",
        { project: projectId },
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new OpError(400, "Request body must be valid JSON", "invalid_input");
    }
    const parsed = ConciergeAskInputSchema.safeParse({
      ...(body as Record<string, unknown>),
      projectId,
    });
    if (!parsed.success)
      throw new OpError(400, "Invalid input", "invalid_input", parsed.error.issues);

    const queued: Array<{ type: string; data: unknown }> = [];
    let wake: (() => void) | undefined;
    let complete = false;
    let failure: unknown;
    let lost = false;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    // Linked before ask() so a client that leaves during preflight still aborts the turn.
    // The auth poll starts only once the SSE body is open (see below).
    const abort = new AbortController();
    const onClientGone = () => abort.abort();
    const detachClient = () => c.req.raw.signal.removeEventListener("abort", onClientGone);
    if (c.req.raw.signal.aborted) onClientGone();
    else c.req.raw.signal.addEventListener("abort", onClientGone);
    const run = service
      .concierge()
      .ask(
        principal,
        projectId,
        {
          text: parsed.data.text,
          context: parsed.data.context,
          conversationId: parsed.data.conversationId,
        },
        (event) => {
          const validated = ConciergeEventSchema.parse(event);
          queued.push({ type: validated.type, data: validated });
          notify();
        },
        abort.signal,
      )
      .then(
        () => {
          complete = true;
          notify();
        },
        (err: unknown) => {
          failure = err;
          complete = true;
          notify();
        },
      );

    // ConciergeService emits `conversation` only after all pre-model checks. Wait for that
    // boundary so validation, authorization, budget and availability refusals remain JSON.
    let opened = false;
    try {
      while (queued.length === 0 && !complete)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      if (queued.length === 0) {
        await run;
        const error = toOpError(failure);
        if (error.status === 499) return c.body(null, 499 as 400);
        return c.json(error.toBody(), error.status as 400);
      }

      c.header("X-Accel-Buffering", "no");
      const response = streamSSE(c, async (stream) => {
        let errorEventSent = false;
        let stopPoll = () => {};
        // Same words as the events stream. `type` is required: the console parses `data`, not the
        // SSE event name, and drops a payload that has no `type`.
        const writeUnauthorized = () =>
          Promise.race([
            stream
              .writeSSE({
                event: "unauthorized",
                data: JSON.stringify({
                  type: "error",
                  code: "unauthenticated",
                  message: principal.kind === "local" ? SIGNED_OUT_MESSAGE : UNAUTHORIZED_MESSAGE,
                }),
              })
              .catch(() => {}),
            new Promise<void>((r) => setTimeout(r, 1000).unref()),
          ]);
        const endLost = async () => {
          await writeUnauthorized();
          await run;
        };
        try {
          stopPoll = pollConciergeAuth(c, principal, () => {
            lost = true;
            onClientGone();
            notify();
          });
          while (queued.length > 0 || !complete) {
            if (lost) return endLost();
            while (queued.length > 0) {
              if (lost) break;
              const event = queued.shift()!;
              if (event.type === "error") errorEventSent = true;
              await stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) });
            }
            if (lost) return endLost();
            if (!complete)
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
          }
          if (lost) return endLost();
          if (failure) {
            const error = toOpError(failure);
            if (error.status !== 499 && !errorEventSent)
              await stream.writeSSE({ event: "error", data: JSON.stringify(error.toBody().error) });
          }
          await run;
        } finally {
          stopPoll();
          detachClient();
        }
      });
      opened = true;
      return response;
    } finally {
      // streamSSE returns the Response before its callback finishes. Detach only when the body
      // never opened, or the request-abort listener dies while the turn is still running.
      if (!opened) detachClient();
    }
  };
  api.post(
    "/v1/projects/:projectId/concierge/messages/stream",
    requireScope("tasks:read"),
    streamConcierge,
  );
  api.post(
    "/projects/:projectId/concierge/messages/stream",
    requireScope("tasks:read"),
    streamConcierge,
  );

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
  // Tell a stalled client at most 1 s: a full socket buffer must not hold the slot.
  const sendUnauthorized = (
    stream: { writeSSE(m: { event: string; data: string }): Promise<void> },
    principal: Principal,
  ) =>
    Promise.race([
      stream
        .writeSSE({
          event: "unauthorized",
          data: principal.kind === "local" ? SIGNED_OUT : UNAUTHORIZED,
        })
        .catch(() => {}),
      new Promise<void>((r) => setTimeout(r, 1000).unref()),
    ]);
  // A browser session is the local principal; a key is a client principal.
  // Re-check a running assistant stream until the SSE callback returns.
  function pollConciergeAuth(c: Context, current: Principal, onLost: () => void): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      stopped = true;
      clearInterval(timer);
    };
    const tick = () => {
      if (stopped) return;
      void resolveSame(c, current)
        .then((fresh) => {
          if (stopped || fresh) return;
          stop();
          onLost();
        })
        .catch(() => {
          if (stopped) return;
          stop();
          onLost();
        });
    };
    tick();
    timer = setInterval(tick, CONCIERGE_AUTH_POLL_MS);
    timer.unref();
    return stop;
  }
  const SIGNED_OUT = JSON.stringify({ message: SIGNED_OUT_MESSAGE });
  const UNAUTHORIZED = JSON.stringify({ message: UNAUTHORIZED_MESSAGE });

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
      let closed = false;
      const finish = () => {
        ended = true;
        if (closed) return;
        closed = true;
        unsub();
        clearInterval(poll);
        clearInterval(beat);
        releaseStream(streamId);
        wake();
      };
      stream.onAbort(finish);
      // A client that left before the response was written never aborts the stream; the request
      // signal does.
      const sig = c.req.raw.signal;
      if (sig.aborted) finish();
      else sig.addEventListener("abort", finish, { once: true });
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ cursor: encodeFeedCursor(cursor) }),
      });
      if (ended) return; // the client left during the greeting: nothing is subscribed yet
      let running: Promise<void> | null = null;
      let again = false;
      const readAll = async () => {
        do {
          again = false;
          for (;;) {
            if (ended) return;
            const batch = await readFeed(service.root, await scopes(), cursor, 200);
            if (batch.length === 0) break;
            for (const e of batch) {
              if (ended) return;
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
          if (ended) return false;
          ended = true; // stops the replay before the event goes out
          await sendUnauthorized(stream, principal);
          finish();
          return false;
        }
        principal = fresh;
        if (ended) return false;
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
        poll = setInterval(() => {
          if (!running) void drain().catch(() => {});
        }, 2000);
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
      let poll: ReturnType<typeof setInterval> | undefined;
      let wake = () => {};
      let closed = false;
      const finish = () => {
        ended = true;
        if (closed) return;
        closed = true;
        unsub();
        clearInterval(poll);
        releaseStream(streamId);
        wake();
      };
      stream.onAbort(finish);
      const sig = c.req.raw.signal;
      if (sig.aborted) finish();
      else sig.addEventListener("abort", finish, { once: true });
      await stream.writeSSE({ event: "ready", data: "connected" });
      if (ended) return;
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
            ended = true;
            await sendUnauthorized(stream, principal);
            finish();
            return;
          }
          principal = fresh;
          if (ended) return;
          // A restricted client never hears about projects it may not read.
          if (data.project && !authorizeProject(principal, data.project)) return;
          await stream.writeSSE({ event, data: JSON.stringify(data) });
        })().catch(() => {});
      });
      poll = setInterval(() => {
        void (async () => {
          if (ended) return;
          const fresh = await resolveSame(c, principal);
          if (!fresh) {
            ended = true;
            await sendUnauthorized(stream, principal);
            finish();
            return;
          }
          principal = fresh;
        })().catch(() => {});
      }, 2000);
      // Keep the connection open until the client disconnects or the key stops working.
      if (!ended)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    });
  });

  app.all(
    "/mcp",
    mcpRoute({ service, authStore, isSelfUrl: deps.isSelfUrl, resolveHost: deps.resolveHost }),
  );

  app.route("/api", api);
  app.all("/api/*", (c) =>
    c.json(
      { error: { code: "not_found", message: `No such route: ${c.req.method} ${c.req.path}` } },
      404,
    ),
  );

  // --- Static UI (optional) ---
  if (deps.uiDir && existsSync(deps.uiDir)) {
    // UI paths get index.html with a relative <base>, so the app works at / and behind a stripped
    // prefix; anything else is a real file or a 404.
    const doc = uiDocument(deps.uiDir);
    app.get("*", (c, next) => (isUiPath(new URL(c.req.url).pathname) ? doc(c) : next()));
    app.use("/*", serveStatic({ root: deps.uiDir }));
  } else {
    app.get("/", (c) => c.text("Boof Runner Agent Task Runner — UI not built. API at api/v1/*"));
  }

  return app;
}
