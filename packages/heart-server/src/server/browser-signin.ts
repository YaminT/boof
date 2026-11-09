import type { Context, MiddlewareHandler } from "hono";
import {
  UnsafeBrowserSessionPathError,
  browserSessionUnavailableMessage,
  browserSessionCookieName,
  type BrowserSessionStore,
  type BrowserSessionVerifier,
  type SecuritySettings,
} from "@boof/heart";
import type { PeerAddressResolver } from "./middleware/auth.js";
import { hostPort, isLoopbackAddress, isLoopbackHost, PROXY_HEADERS } from "./middleware/auth.js";

const INVALID_LINK =
  'This sign-in link is invalid, used or expired. Run "boof-runner open" on this machine for a new one.';
function loopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return isLoopbackHost(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export interface BrowserSigninOptions {
  security: () => Promise<SecuritySettings>;
  peerAddress: PeerAddressResolver;
  sessions: BrowserSessionVerifier & { redeemLink?: BrowserSessionStore["redeemLink"] };
  sessionCookieName?: (c: Context) => string;
}

/** GET /auth/browser exchanges one single-use local sign-in code for an HttpOnly session cookie. */
export function browserSignin(opts: BrowserSigninOptions): MiddlewareHandler {
  return async (c) => {
    const { auth } = await opts.security();
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (
      auth.mode !== "local-trust" ||
      !isLoopbackAddress(opts.peerAddress(c)) ||
      !loopbackHost(host) ||
      PROXY_HEADERS.some((name) => c.req.header(name) !== undefined)
    ) {
      return c.body(null, 404);
    }
    if (c.req.method !== "GET") return c.body(null, 405);

    const code = c.req.query("code");
    const redeem = opts.sessions.redeemLink;
    let result: Awaited<ReturnType<BrowserSessionStore["redeemLink"]>> = null;
    try {
      if (code && redeem) result = await redeem.call(opts.sessions, code);
    } catch (error) {
      if (error instanceof UnsafeBrowserSessionPathError) {
        c.set("auditExtra", { action: "auth:browser-session", outcome: "error" });
        return c.text(
browserSessionUnavailableMessage(error.path),
          503,
          { "Cache-Control": "no-store" },
        );
      }
      throw error;
    }

    if (!result) {
      c.set("auditExtra", { action: "auth:browser-session", outcome: "error" });
      const limited = c.get("authFailed")?.(c);
      if (limited) return limited;
      return c.html(INVALID_LINK, 400, { "Cache-Control": "no-store" });
    }

    const name = opts.sessionCookieName?.(c) ?? browserSessionCookieName(hostPort(host));
    // Cookies are shared across ports; the port in this name only prevents the boof servers from
    // confusing one another. It does not stop another local listener from receiving the cookie.
    c.header(
      "Set-Cookie",
      `${name}=${result.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
    );
    c.header("Cache-Control", "no-store");
    c.header("Location", "/");
    c.set("auditExtra", { action: "auth:browser-session", outcome: "ok" });
    return c.body(null, 303);
  };
}
