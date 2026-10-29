import type { MiddlewareHandler } from "hono";

/**
 * A browser page must not drive the API: an `Origin`, when sent, has to be this server itself,
 * i.e. its host AND port equal the request's `Host` header (the desktop app, the Vite proxy and
 * an nginx that keeps `Host` all satisfy this), or equal an `allowedHosts` entry that names an
 * explicit port. Browsers send an `Origin` on every cross-origin request except no-cors GETs
 * (`<img>`, `<script>` send none) and on every POST (`null` in some privacy modes, refused too);
 * non-browser clients send none. The design is safe only because no GET changes state: a future
 * state-changing GET would NOT be covered by this guard.
 */
export function originGuard(allowedHosts: () => Promise<readonly string[]>): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      let ok = false;
      try {
        const host = new URL(origin).host.toLowerCase();
        const own = (c.req.header("host") ?? "").trim().toLowerCase();
        ok =
          (own !== "" && host === own) ||
          (await allowedHosts()).some((h) => /:\d+$/.test(h) && h.trim().toLowerCase() === host);
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
  };
}
