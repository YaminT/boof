import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { AuthStore, authorizeProject, MAX_ATTACHMENT_BYTES } from "@boof-runner/shared";
import {
  buildOpenApi,
  IdempotencyStore,
  registry,
  toOpError,
  type AnyOperation,
  type TaskService,
} from "@boof-runner/api";
import { hostGuard } from "./middleware/host-guard.js";
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
import { LEGACY_SUNSET, mountOps } from "./rest.js";

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
  /** Clock override for tests (rate limit, client cache, audit). */
  now?: () => number;
}

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
  // Outermost on /api so rejected requests (401/403/429) are audited too.
  app.use("/api/*", audit({ root: service.root, security, now: deps.now }));

  const tooLarge = (c: Context) =>
    c.json({ error: { code: "payload_too_large", message: "Request body too large" } }, 413);
  const jsonLimit = bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: tooLarge });
  const attachmentLimit = bodyLimit({ maxSize: ATTACHMENT_BODY_LIMIT, onError: tooLarge });
  app.use("/api/*", (c, next) =>
    c.req.method === "POST" &&
    /^\/api\/(v1\/)?(projects\/[^/]+\/)?tasks\/[^/]+\/attachments\/?$/.test(c.req.path)
      ? attachmentLimit(c, next)
      : jsonLimit(c, next),
  );
  app.use("/api/*", authenticate({ store: authStore, security, peerAddress, now: deps.now }));
  app.use("/api/*", rateLimit({ security, now: deps.now }));

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
  const restDeps = { service, authStore, idempotency };
  // The contract, generated once from the registry. Any authenticated principal may read it.
  let openapi: string | undefined;
  api.get("/v1/openapi.json", (c) => {
    openapi ??= JSON.stringify(buildOpenApi(registry));
    return c.body(openapi, 200, { "Content-Type": "application/json" });
  });
  mountOps(api, registry as readonly AnyOperation[], restDeps, { prefix: "/v1", legacy: false });
  mountOps(api, registry as readonly AnyOperation[], restDeps, { prefix: "", legacy: true });

  // --- SSE live updates ---
  const who = (c: Context) => c.get("principal");
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
