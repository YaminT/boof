import { isLoopbackAddress } from "./auth.js";

export interface ClientAddress {
  /** The socket peer. */
  peer: string | undefined;
  /** The address a proxy forwarded (last X-Forwarded-For entry, else the last Forwarded for=), when the peer is loopback or a trusted proxy and a header is present. */
  forwardedFor?: string;
  /** forwardedFor when the peer is a trusted proxy, else the peer; the limiter's key. */
  key: string;
}

const strip = (a: string) => a.toLowerCase().replace(/^::ffff:/, "");

/** `"loopback"` matches 127.0.0.0/8 and ::1; anything else is an IP literal. */
export function isTrustedProxy(peer: string | undefined, trusted: readonly string[]): boolean {
  if (!peer) return false;
  return trusted.some((t) =>
    t === "loopback" ? isLoopbackAddress(peer) : strip(t) === strip(peer),
  );
}

/** The `for=` value of one RFC 7239 element, unquoted and without brackets or port. */
function forwardedElementFor(element: string): string | undefined {
  for (const pair of element.split(";")) {
    const m = /^\s*for\s*=\s*(.+?)\s*$/i.exec(pair);
    if (!m) continue;
    let v = m[1].replace(/^"(.*)"$/, "$1");
    if (v.startsWith("[")) v = v.slice(1, v.indexOf("]") === -1 ? undefined : v.indexOf("]"));
    else if (/^[^:]+:\d+$/.test(v)) v = v.slice(0, v.indexOf(":"));
    return v || undefined;
  }
  return undefined;
}

/**
 * The client address the nearest proxy appended: the last X-Forwarded-For entry (earlier ones are
 * client-controlled), else the last `Forwarded` element's `for=`.
 */
export function lastForwardedFor(
  xff: string | undefined,
  forwarded: string | undefined,
): string | undefined {
  const last = xff
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .at(-1);
  if (last) return last;
  const element = forwarded?.split(",").at(-1);
  return element ? forwardedElementFor(element) : undefined;
}

export function clientAddress(
  header: (name: string) => string | undefined,
  peer: string | undefined,
  trusted: readonly string[],
): ClientAddress {
  const fwd = lastForwardedFor(header("x-forwarded-for"), header("forwarded"));
  const trustedPeer = isTrustedProxy(peer, trusted);
  const forwardedFor = fwd && (trustedPeer || isLoopbackAddress(peer)) ? fwd : undefined;
  return { peer, forwardedFor, key: trustedPeer && fwd ? fwd : (peer ?? "unknown") };
}
