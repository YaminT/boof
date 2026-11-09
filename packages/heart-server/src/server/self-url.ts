import { networkInterfaces } from "node:os";
import { hostnameOf } from "./middleware/host-guard.js";

export interface SelfUrlOptions {
  /** The port boof answers on; a function when it is known only after listening (port 0). */
  port: number | (() => number);
  /** The host boof is bound to, when it is a named address. */
  bindHost?: string;
  /** Extra names boof answers to (security.allowedHosts and the like); a port is ignored. */
  allowedHosts?: readonly string[];
}

const bracket = (h: string): string => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);

/** `[::ffff:7f00:1]` or `[::ffff:127.0.0.1]` → `127.0.0.1`; anything else is returned as is. */
function unwrapMapped(hostname: string): string {
  const m = /^\[::ffff:(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))\]$/i.exec(hostname);
  if (!m) return hostname;
  if (m[3]) return m[3];
  const hi = parseInt(m[1]!, 16);
  const lo = parseInt(m[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/**
 * Tells whether a URL points at this boof server: the bound port on a loopback name, a name boof
 * is bound or allowed to answer to, or one of this machine's interface addresses. A webhook or n8n
 * host must never be boof itself.
 */
export function createSelfUrlCheck(opts: SelfUrlOptions): (url: URL) => boolean {
  const names = new Set<string>(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
  if (opts.bindHost) names.add(bracket(hostnameOf(opts.bindHost)));
  for (const h of opts.allowedHosts ?? []) names.add(bracket(hostnameOf(h)));
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) names.add(a.family === "IPv6" ? `[${a.address}]` : a.address);
  }
  return (url: URL): boolean =>
    Number(url.port || (url.protocol === "https:" ? 443 : 80)) ===
      (typeof opts.port === "function" ? opts.port() : opts.port) &&
    names.has(unwrapMapped(url.hostname.toLowerCase()));
}
