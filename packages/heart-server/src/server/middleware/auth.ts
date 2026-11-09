import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { UNSAFE_DATA_FOLDER_MESSAGE, logUnsafeDataFolder } from "../../api/errors.js";
import type { ClientAddress } from "./client-address.js";
import {
  UnsafeBrowserSessionPathError,
  browserSessionUnavailableMessage,
  authorize,
  LOCAL_PRINCIPAL,
  UnsafeSecretPathError,
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

/** One line for a log: the message of an error, never its stack. */
function errorLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/[\r\n]+/g, " ");
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
      const mtime = await this.store.mtimeMs();
      if (localChange || mtime !== this.mtime) {
        this.clients = await this.store.list();
        this.mtime = mtime;
        this.version = this.store.version;
      }
      // Only after the check ran: a failing check stays failing instead of serving the cache.
      this.checkedAt = t;
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

const WELL_FORMED_SESSION = /^bs_[A-Za-z0-9_-]{43}$/;
/** A request is checked against at most this many well-formed session values; the rest are ignored. */
const MAX_SESSION_VALUES = 4;

function unavailableMessage(error: unknown): string | undefined {
  if (!(error instanceof UnsafeBrowserSessionPathError)) return undefined;
  return browserSessionUnavailableMessage(error.path);
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
  const unavailable = (error: UnsafeSecretPathError, c: Context) => (
    logUnsafeDataFolder(error),
    c.json({ error: { code: "auth_store_unavailable", message: UNSAFE_DATA_FOLDER_MESSAGE } }, 503)
  );

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
      const tokens = cookieValues(c, opts.sessionCookieName?.(c) ?? "")
        .filter((value) => WELL_FORMED_SESSION.test(value))
        .slice(0, MAX_SESSION_VALUES);
      let session = null;
      let unavailable: string | undefined;
      if (allowedFetchSite) {
        for (const token of tokens.length > 0 ? tokens : [undefined]) {
          try {
            session = (await opts.browserSessions?.verify(token)) ?? null;
          } catch (error) {
            // A throw is "not valid", unless it is the store's unsafe-path error.
            unavailable = unavailableMessage(error) ?? unavailable;
          }
          if (session) break;
        }
      }
      if (!session && opts.browserSessions?.unavailableMessage) {
        unavailable = (await opts.browserSessions.unavailableMessage()) ?? unavailable;
      }
      if (!session && unavailable) {
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
      opts.store.touch(client.id).catch((err) => {
        if (err instanceof UnsafeSecretPathError) logUnsafeDataFolder(err);
        else console.error(`lastUsedAt update failed: ${errorLine(err)}`);
      });
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
    let r: AuthResult;
    try {
      r = await resolve(c);
    } catch (error) {
      if (error instanceof UnsafeSecretPathError) return unavailable(error, c);
      throw error;
    }
    if (!r.ok) {
      const name = opts.sessionCookieName?.(c) ?? "";
      const presentedCredential =
        c.req.header("authorization") !== undefined || cookieValues(c, name).length > 0;
      const limited = presentedCredential ? c.get("authFailed")?.(c) : undefined;
      if (limited) return limited;
      if (r.reason === "browser_sessions_unavailable") {
        return c.json(
          {
            error: {
              code: "browser_sessions_unavailable",
              message: UNSAFE_DATA_FOLDER_MESSAGE,
              details: { reason: r.reason },
            },
          },
          503,
          { "Cache-Control": "no-store" },
        );
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
