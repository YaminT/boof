import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import type { ClientAddress } from "./client-address.js";
import {
  UnsafeBrowserSessionPathError,
  authorize,
  LOCAL_PRINCIPAL,
  type AuthStore,
  type BrowserSessionVerifier,
  type Client,
  type Principal,
  type Scope,
  type SecuritySettings,
} from "@boof/heart";

declare module "hono" {
  interface ContextVariableMap {
    principal: Principal;
    peerAddress: string | undefined;
    clientAddress: ClientAddress;
    /** Extra fields the handler wants recorded in the audit line (never bodies or secrets). */
    auditExtra: Record<string, unknown>;
    /** Set by the unauthenticated limiter: called when authentication fails; returns a 429 when the address is over its budget. */
    authFailed: (c: Context) => Response | undefined;
  }
}

/** Resolves the TCP peer address of a request; undefined when there is no socket (tests). */
export type PeerAddressResolver = (c: Context) => string | undefined;

export const defaultPeerAddress: PeerAddressResolver = (c) => {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
};

/** 127.0.0.0/8, ::1 and their IPv4-mapped forms. A missing address is NOT loopback. */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  if (a === "::1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** Bind hosts that only accept local connections. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || isLoopbackAddress(h);
}

const CACHE_CHECK_MS = 5_000;
const TOUCH_INTERVAL_MS = 60_000;

/** Client list cached in memory; reloaded when clients.json changes (checked at most every 5 s). */
class ClientCache {
  private clients: Client[] = [];
  private mtime = -1;
  private version = -1;
  private checkedAt = -Infinity;

  constructor(
    private readonly store: AuthStore,
    private readonly now: () => number,
  ) {}

  async get(): Promise<Client[]> {
    const t = this.now();
    const localChange = this.version !== this.store.version;
    if (localChange || t - this.checkedAt >= CACHE_CHECK_MS) {
      this.checkedAt = t;
      const mtime = await this.store.mtimeMs();
      if (localChange || mtime !== this.mtime) {
        this.clients = await this.store.list();
        this.mtime = mtime;
        this.version = this.store.version;
      }
    }
    return this.clients;
  }
}

export const PROXY_HEADERS = [
  "x-forwarded-for",
  "forwarded",
  "x-real-ip",
  "x-forwarded-host",
  "x-forwarded-proto",
  "via",
];

/** Port used when deriving a cookie name from an HTTP Host header. */
export function hostPort(host: string | undefined): number {
  if (!host) return 80;
  try {
    const port = new URL(`http://${host}`).port;
    return port ? Number(port) : 80;
  } catch {
    return 80;
  }
}

export function principalFromClient(client: Client, opts: { operator?: boolean } = {}): Principal {
  return {
    kind: "client",
    id: client.id,
    name: client.name,
    scopes: new Set(client.scopes),
    projects: client.projects === "*" ? "*" : new Set(client.projects),
    trust: client.trust,
    clientKind: client.kind,
    ...(opts.operator ? { operator: true as const } : {}),
  };
}

const M1 =
  'MCP needs an API key. Send "Authorization: Bearer <key>"; create one with "boof-runner auth add --name <name> --scopes <list> --trust review". Keyless MCP on loopback was removed (see the CHANGELOG, "Breaking changes and upgrade notes").';
const M2 =
  'Keyless access on this machine is only for the boof web UI after sign-in. Open the UI with the link that "boof-runner open" prints, or send "Authorization: Bearer <key>" (create one with "boof-runner auth add").';

function cookieValues(c: Context, name: string): string[] {
  const raw = c.req.header("cookie");
  if (!raw) return [];
  const values: string[] = [];
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    values.push(part.slice(separator + 1).trim());
  }
  return values;
}

function unavailableMessage(error: unknown): string | undefined {
  if (!(error instanceof UnsafeBrowserSessionPathError)) return undefined;
  return `Browser sign-in is unavailable: ${error.message}. Fix the data-root permissions, then run "boof-runner open" again.`;
}

export interface AuthenticateOptions {
  store: AuthStore;
  security: () => Promise<SecuritySettings>;
  peerAddress: PeerAddressResolver;
  now?: () => number;
  /**
   * Client ids the server treats as the local operator, but only for a key with full power (admin
   * scope, trusted, every project, no expiry) used from loopback without proxy headers.
   */
  operatorClients?: ReadonlySet<string>;
  /** Optional browser-session verifier; consumed by the local-trust browser gate. */
  browserSessions?: BrowserSessionVerifier;
  /** Cookie name for the bound server port. */
  sessionCookieName?: (c: Context) => string;
}

export type AuthResult =
  | { ok: true; principal: Principal }
  | {
      ok: false;
      message: string;
      reason?: "browser_session_required" | "mcp_key_required" | "browser_sessions_unavailable";
    };

export interface Authenticator {
  middleware: MiddlewareHandler;
  /** The principal a request would get right now; what the middleware runs, callable again later (an SSE tick). */
  resolve(c: Context): Promise<AuthResult>;
}

/**
 * Establish the request's principal.
 * - `Authorization: Bearer boof_...` is verified against the client registry.
 * - No header, loopback peer, no proxy headers, mode `local-trust`, valid browser cookie -> local principal.
 * - Anything else -> 401.
 */
export function createAuthenticator(opts: AuthenticateOptions): Authenticator {
  const now = opts.now ?? Date.now;
  const cache = new ClientCache(opts.store, now);
  const lastTouch = new Map<string, number>();

  const resolve = async (c: Context): Promise<AuthResult> => {
    const peer = opts.peerAddress(c);
    const header = c.req.header("authorization");

    if (header === undefined) {
      const { auth } = await opts.security();
      if (auth.mode !== "local-trust") return { ok: false, message: "Authentication required" };
      const proxied = PROXY_HEADERS.some((name) => c.req.header(name) !== undefined);
      if (!isLoopbackAddress(peer) || proxied) {
        return { ok: false, message: "Authentication required" };
      }
      if (c.req.path === "/mcp") {
        c.set("auditExtra", { reason: "mcp_key_required" });
        return { ok: false, message: M1, reason: "mcp_key_required" };
      }
      const fetchSite = c.req.header("sec-fetch-site");
      const allowedFetchSite =
        fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "none";
      const tokens = cookieValues(c, opts.sessionCookieName?.(c) ?? "");
      let session = null;
      let unavailable: string | undefined;
      if (allowedFetchSite) {
        for (const token of tokens.length > 0 ? tokens : [undefined]) {
          try {
            session = (await opts.browserSessions?.verify(token)) ?? null;
          } catch (error) {
            unavailable = unavailableMessage(error);
          }
          if (session) break;
        }
      }
      if (!session && opts.browserSessions?.unavailableMessage) {
        unavailable = (await opts.browserSessions.unavailableMessage()) ?? unavailable;
      }
      if (unavailable) {
        c.set("auditExtra", { reason: "browser_sessions_unavailable" });
        return { ok: false, message: unavailable, reason: "browser_sessions_unavailable" };
      }
      if (session) {
        c.set("auditExtra", { auth: "browser-session", session: session.id });
        return { ok: true, principal: LOCAL_PRINCIPAL };
      }
      c.set("auditExtra", { reason: "browser_session_required" });
      return { ok: false, message: M2, reason: "browser_session_required" };
    }

    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!m) return { ok: false, message: "Malformed Authorization header" };
    const result = opts.store.verifyAgainst(await cache.get(), m[1]);
    if (!result.ok) {
      const message =
        result.reason === "revoked"
          ? "API key revoked"
          : result.reason === "expired"
            ? "API key expired"
            : "Invalid API key";
      return { ok: false, message };
    }

    const { client } = result;
    const t = now();
    if (t - (lastTouch.get(client.id) ?? -Infinity) >= TOUCH_INTERVAL_MS) {
      lastTouch.set(client.id, t);
      opts.store.touch(client.id).catch((err) => console.error("lastUsedAt update failed", err));
    }
    // A local reverse proxy makes every peer look like loopback. Any common proxy header counts.
    const proxied = PROXY_HEADERS.some((h) => c.req.header(h) !== undefined);
    const operator =
      opts.operatorClients?.has(client.id) === true &&
      isLoopbackAddress(peer) &&
      !proxied &&
      client.scopes.includes("admin") &&
      client.trust === "trusted" &&
      client.projects === "*" &&
      !client.expiresAt;
    return { ok: true, principal: principalFromClient(client, { operator }) };
  };

  const middleware: MiddlewareHandler = async (c, next) => {
    c.set("peerAddress", opts.peerAddress(c));
    const r = await resolve(c);
    if (!r.ok) {
      const name = opts.sessionCookieName?.(c) ?? "";
      const presentedCredential =
        c.req.header("authorization") !== undefined || cookieValues(c, name).length > 0;
      const limited = presentedCredential ? c.get("authFailed")?.(c) : undefined;
      if (limited) return limited;
      if (r.reason === "browser_sessions_unavailable") {
        return c.text(r.message, 503, { "Cache-Control": "no-store" });
      }
      c.header("WWW-Authenticate", 'Bearer realm="boof-runner"');
      return c.json(
        {
          error: {
            code: "unauthenticated",
            message: r.message,
            ...(r.reason ? { details: { reason: r.reason } } : {}),
          },
        },
        401,
      );
    }
    c.set("principal", r.principal);
    return next();
  };
  return { middleware, resolve };
}

export function authenticate(opts: AuthenticateOptions): MiddlewareHandler {
  return createAuthenticator(opts).middleware;
}

/** Per-route scope check: 403 `forbidden_scope` unless the principal holds the scope. */
export function requireScope(scope: Scope): MiddlewareHandler {
  return async (c, next) => {
    if (!authorize(c.get("principal"), scope)) {
      return c.json(
        {
          error: {
            code: "forbidden_scope",
            message: `Missing required scope: ${scope}`,
            details: { scope },
          },
        },
        403,
      );
    }
    await next();
  };
}

/** Like {@link requireScope} but any one of `scopes` suffices. */
export function requireAnyScope(scopes: Scope[]): MiddlewareHandler {
  return async (c, next) => {
    const principal = c.get("principal");
    if (!scopes.some((s) => authorize(principal, s))) {
      return c.json(
        {
          error: {
            code: "forbidden_scope",
            message: `Missing required scope: ${scopes.join(" or ")}`,
            details: { scope: scopes[0], anyOf: scopes },
          },
        },
        403,
      );
    }
    await next();
  };
}
