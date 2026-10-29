import type { MiddlewareHandler } from "hono";
import { isHostAllowed } from "./host-guard.js";

/**
 * A browser page must not drive the API: an `Origin`, when sent, has to name a loopback host or
 * an allowed host. Browsers send one on every cross-site request and every POST (`null` in some
 * privacy modes, which is refused too); non-browser clients send none.
 */
export function originGuard(allowedHosts: () => Promise<readonly string[]>): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      let ok = false;
      try {
        ok = isHostAllowed(new URL(origin).host, await allowedHosts());
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
