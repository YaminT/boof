import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { AuthStore, authorizeProject, isKebabId, MAX_ATTACHMENT_BYTES } from "@boof-runner/shared";
import {
  buildOpenApi,
  IdempotencyStore,
  OpError,
  registry,
  toOpError,
  type AnyOperation,
  type TaskService,
} from "@boof-runner/api";
import { hostGuard, isHostAllowed } from "./middleware/host-guard.js";
import {
  authenticate,
  defaultPeerAddress,
  requireScope,
  type PeerAddressResolver,
} from "./middleware/auth.js";
import { rateLimit } from "./middleware/rate-limit.js";
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
  /** Clock override for tests (rate limit, client cache, audit). */
  now?: () => number;
}

const MARKDOWN = "text/markdown; charset=utf-8";
const PLAIN = "text/plain; charset=utf-8";

/** llms.txt (llmstxt.org): what boof is and where an agent starts. */
const LLMS_TXT = `# boof-runner

> boof-runner is a local task runner for coding agents. Register a git repository as a project, submit plans of goals or single prompts, and boof runs them through a planner, developer, observer and reviewer pipeline in git worktrees. You operate it over a REST API or MCP with a host URL and an API key.

## Docs

- [Harness guide](/harness.txt): the complete guide for an AI agent: connection, concepts, every REST operation, workflows
- [OpenAPI](/api/v1/openapi.json): the machine-readable REST contract (needs an API key)
`;

const JSON_BODY_LIMIT = 1_000_000;
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
  app.use("*", secureHeaders());
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
  // A browser page must not drive the MCP endpoint: an Origin, when sent, has to name an allowed host.
  app.use("/mcp", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      let ok = false;
      try {
        const extra = [...(deps.allowedHosts ?? []), ...(await security()).allowedHosts];
        ok = isHostAllowed(new URL(origin).host, extra);
      } catch {
        ok = false;
      }
      if (!ok) {
        return c.json(
          { error: { code: "origin_not_allowed", message: "Origin not allowed" } },
          403,
        );
      }
    }
    await next();
  });
  const authenticator = authenticate({ store: authStore, security, peerAddress, now: deps.now });
  const limiter = rateLimit({ security, now: deps.now });
  for (const path of guarded) {
    app.use(path, authenticator);
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
          `<${c.req.path.replace(/^\/api\//, "/api/v1/")}>; rel="successor-version"`,
        );
      }
    }
    await next();
  });

  const idempotency = new IdempotencyStore(service.root);
  const restDeps = { service, authStore, idempotency, isSelfUrl: deps.isSelfUrl };
  // The contract, generated once from the registry. Any authenticated principal may read it.
  let openapi: string | undefined;
  api.get("/v1/openapi.json", (c) => {
    openapi ??= JSON.stringify(buildOpenApi(registry));
    return c.body(openapi, 200, { "Content-Type": "application/json" });
  });
  mountOps(api, registry as readonly AnyOperation[], restDeps, { prefix: "/v1", legacy: false });
  mountOps(api, registry as readonly AnyOperation[], restDeps, { prefix: "", legacy: true });

  const who = (c: Context) => c.get("principal");

  // --- SSE ---
  // v1: typed events from the events files, replayable by cursor (see events.ts).
  api.get("/v1/events", requireScope("tasks:read"), async (c) => {
    const principal = who(c);
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
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ cursor: encodeFeedCursor(cursor) }),
      });
      let draining = false;
      let again = false;
      const drain = async () => {
        if (draining) {
          again = true;
          return;
        }
        draining = true;
        try {
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
        } finally {
          draining = false;
        }
      };
      await drain();
      if (!deps.watcher) return; // no live source (tests): replay only
      const unsub = deps.watcher.subscribe((_event, data) => {
        // Typed events first (replayable); then a `changed` hint for file changes that are not
        // events (a streaming log, an edited prompt). Hints are never replayed.
        if (data.project && !authorizeProject(principal, data.project)) return;
        if (project && data.project && data.project !== project) return;
        void drain()
          .then(() => stream.writeSSE({ event: "changed", data: JSON.stringify(data) }))
          .catch(() => {});
      });
      const poll = setInterval(() => void drain().catch(() => {}), 2000);
      const beat = setInterval(() => void stream.write(": keepalive\n\n").catch(() => {}), 15000);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          unsub();
          clearInterval(poll);
          clearInterval(beat);
          resolve();
        });
      });
    });
  });

  // Deprecated: untyped `changed` pings (the old UI refetches on each).
  api.get("/events", requireScope("tasks:read"), (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "ready", data: "connected" });
      if (!deps.watcher) {
        // No watcher (e.g. tests): keep the stream open briefly then end.
        return;
      }
      const unsub = deps.watcher.subscribe((event, data) => {
        // A restricted client never hears about projects it may not read.
        if (data.project && !authorizeProject(who(c), data.project)) return;
        void stream.writeSSE({ event, data: JSON.stringify(data) });
      });
      // Keep the connection open until the client disconnects.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          unsub();
          resolve();
        });
      });
    }),
  );

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
    app.get("/", (c) => c.text("Boof Runner Agent Task Runner — UI not built. API at /api/*"));
  }

  return app;
}
