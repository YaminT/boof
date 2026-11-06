import type { MiddlewareHandler } from "hono";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Strip an optional `:port` from a Host header value (IPv6 literals keep their brackets). */
export function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.lastIndexOf(":");
  return colon === -1 ? h : h.slice(0, colon);
}

/** True when `host` (a Host header or the host part of an Origin) is loopback or in `extra`. */
export function isHostAllowed(host: string, extra: readonly string[] = []): boolean {
  const name = hostnameOf(host);
  return LOOPBACK_HOSTS.has(name) || extra.some((h) => hostnameOf(h) === name);
}

/**
 * Reject requests whose Host header is not a loopback name or an explicitly
 * allowed host. This blocks DNS-rebinding attacks: a website whose DNS flips
 * to 127.0.0.1 still sends its own name in Host, so it never reaches the API.
 */
export function hostGuard(
  allowedHosts: () => readonly string[] | Promise<readonly string[]> = () => [],
): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.header("host") ?? new URL(c.req.url).host;
    if (!isHostAllowed(raw, await allowedHosts())) {
      return c.json(
        { error: { code: "host_not_allowed", message: "Host not allowed" } },
        421 as 400,
      );
    }
    await next();
  };
}
