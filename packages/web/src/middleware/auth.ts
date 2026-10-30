import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import type { ClientAddress } from "./client-address.js";
import {
  authorize,
  LOCAL_PRINCIPAL,
  type AuthStore,
  type Client,
  type Principal,
  type Scope,
  type SecuritySettings,
} from "@boof-runner/shared";

declare module "hono" {
  interface ContextVariableMap {
    principal: Principal;
    peerAddress: string | undefined;
    clientAddress: ClientAddress;
    /** Extra fields the handler wants recorded in the audit line (never bodies or secrets). */
    auditExtra: Record<string, unknown>;
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

export function principalFromClient(client: Client): Principal {
  return {
    kind: "client",
    id: client.id,
    name: client.name,
    scopes: new Set(client.scopes),
    projects: client.projects === "*" ? "*" : new Set(client.projects),
    trust: client.trust,
    clientKind: client.kind,
  };
}

function unauthenticated(c: Context, message = "Authentication required") {
  c.header("WWW-Authenticate", 'Bearer realm="boof-runner"');
  return c.json({ error: { code: "unauthenticated", message } }, 401);
}

export interface AuthenticateOptions {
  store: AuthStore;
  security: () => Promise<SecuritySettings>;
  peerAddress: PeerAddressResolver;
  now?: () => number;
}

export type AuthResult = { ok: true; principal: Principal } | { ok: false; message: string };

export interface Authenticator {
  middleware: MiddlewareHandler;
  /** The principal a request would get right now; what the middleware runs, callable again later (an SSE tick). */
  resolve(c: Context): Promise<AuthResult>;
}

/**
 * Establish the request's principal.
 * - `Authorization: Bearer boof_...` is verified against the client registry.
 * - No header, loopback peer, no proxy headers, mode `local-trust` -> the local principal.
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
      // A local reverse proxy makes every peer look like loopback; never trust those.
      const proxied =
        c.req.header("x-forwarded-for") !== undefined || c.req.header("forwarded") !== undefined;
      if (auth.mode === "local-trust" && isLoopbackAddress(peer) && !proxied) {
        return { ok: true, principal: LOCAL_PRINCIPAL };
      }
      return { ok: false, message: "Authentication required" };
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
    return { ok: true, principal: principalFromClient(client) };
  };

  const middleware: MiddlewareHandler = async (c, next) => {
    c.set("peerAddress", opts.peerAddress(c));
    const r = await resolve(c);
    if (!r.ok) return unauthenticated(c, r.message);
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
