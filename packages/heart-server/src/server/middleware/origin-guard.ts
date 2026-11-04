import type { Context, MiddlewareHandler } from "hono";

const DEFAULT_PORT: Record<string, string> = { "http:": "80", "https:": "443" };

/** `host[:port]` as `hostname:port`, with `defaultPort` filled in when none is given. */
function normalise(hostPort: string, defaultPort: string): string | undefined {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostPort.trim().toLowerCase());
  return m ? `${m[1]}:${m[2] ?? defaultPort}` : undefined;
}

/**
 * A browser page must not drive the API. On `/api/*` and `/mcp`:
 * - `Sec-Fetch-Site: cross-site` is refused outright. Browsers send it on every request, including
 *   the no-cors GETs (`<img>`, `<script>`) that carry no `Origin`; non-browser clients send none.
 * - An `Origin`, when sent, has to be this server itself, i.e. its host AND port equal the
 *   request's `Host` header (the desktop app, the Vite proxy and an nginx that keeps `Host` all
 *   satisfy this), or equal an `allowedHosts` entry. Both sides get the Origin scheme's default
 *   port (80 or 443) filled in, so `https://example.com` matches `Host: example.com:443`, and an
 *   entry without a port matches only the default port; an entry with a port matches that port.
 * Browsers send an `Origin` on every cross-origin request except no-cors GETs and on every POST
 * (`null` in some privacy modes, refused too). The Origin check relies on no GET changing state.
 */
export function originGuard(allowedHosts: () => Promise<readonly string[]>): MiddlewareHandler {
  const refuse = (c: Context) =>
    c.json({ error: { code: "origin_not_allowed", message: "Origin not allowed" } }, 403);
  return async (c, next) => {
    if (c.req.header("sec-fetch-site")?.trim().toLowerCase() === "cross-site") return refuse(c);
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      let ok = false;
      try {
        const url = new URL(origin);
        const def = DEFAULT_PORT[url.protocol];
        if (def === undefined) throw new Error("unsupported scheme");
        const want = normalise(url.host, def);
        const own = normalise(c.req.header("host") ?? "", def);
        ok =
          want !== undefined &&
          ((own !== undefined && own === want) ||
            (await allowedHosts()).some((h) => normalise(h, def) === want));
      } catch {
        ok = false;
      }
      if (!ok) return refuse(c);
    }
    await next();
  };
}
