import dns from "node:dns";
import net from "node:net";
import { OpError } from "./errors.js";
import { assertWebhookUrl } from "./ops/webhooks.js";

export type BlockedRange =
  | "unspecified"
  | "loopback"
  | "private"
  | "link-local"
  | "carrier-grade-nat"
  | "multicast"
  | "reserved"
  | "documentation";

type Family = "ipv4" | "ipv6";

const ranges = new Map<BlockedRange, net.BlockList>();
function block(range: BlockedRange, family: Family, ...cidrs: string[]): void {
  const list = ranges.get(range) ?? new net.BlockList();
  for (const cidr of cidrs) {
    const [addr, prefix] = cidr.split("/");
    list.addSubnet(addr, Number(prefix), family);
  }
  ranges.set(range, list);
}

block("unspecified", "ipv4", "0.0.0.0/8");
block("unspecified", "ipv6", "::/128");
block("loopback", "ipv4", "127.0.0.0/8");
block("loopback", "ipv6", "::1/128");
block("private", "ipv4", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16");
block("private", "ipv6", "fc00::/7");
block("link-local", "ipv4", "169.254.0.0/16");
block("link-local", "ipv6", "fe80::/10");
block("carrier-grade-nat", "ipv4", "100.64.0.0/10");
block("multicast", "ipv4", "224.0.0.0/4");
block("multicast", "ipv6", "ff00::/8");
block("reserved", "ipv4", "240.0.0.0/4", "192.0.0.0/24", "192.88.99.0/24", "198.18.0.0/15");
// IPv4-compatible (::/96), IPv4-translated SIIT (::ffff:0:a.b.c.d), deprecated site-local,
// discard-only, and local-use NAT64 (RFC 8215, blocked outright rather than decoded).
block(
  "reserved",
  "ipv6",
  "::/96",
  "::ffff:0:0:0/96",
  "fec0::/10",
  "100::/64",
  "64:ff9b:1::/48",
  "2001::/32",
);
block("documentation", "ipv4", "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24");
block("documentation", "ipv6", "2001:db8::/32");

const nat64 = new net.BlockList();
nat64.addSubnet("64:ff9b::", 96, "ipv6");

const sixToFour = new net.BlockList();
sixToFour.addSubnet("2002::", 16, "ipv6");

/** The 8 groups of an IPv6 address as numbers (handles `::` and a dotted-quad tail). */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text =
      text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = text.split("::");
  const front = head ? head.split(":") : [];
  const back = tail === undefined ? [] : tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array<string>(8 - front.length - back.length).fill("0");
  return [...front, ...fill, ...back].map((g) => parseInt(g, 16));
}

/** Why `address` may not be a webhook target, or null for a public address. */
export function blockedAddressReason(address: string): BlockedRange | null {
  const family = net.isIP(address);
  if (family === 0) return "reserved"; // never public by accident
  const type: Family = family === 4 ? "ipv4" : "ipv6";
  if (type === "ipv6" && nat64.check(address, "ipv6")) {
    const g = ipv6Groups(address);
    return blockedAddressReason(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  if (type === "ipv6" && sixToFour.check(address, "ipv6")) {
    // 6to4 (2002::/16) embeds the IPv4 address in bits 16-47: classify that address.
    const g = ipv6Groups(address);
    return blockedAddressReason(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`);
  }
  // BlockList checks an IPv4-mapped IPv6 address (::ffff:a.b.c.d) against the IPv4 ranges itself.
  for (const [range, list] of ranges) if (list.check(address, type)) return range;
  return null;
}

/** Lower-case hostname with the IPv6 brackets stripped. */
export function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

/** Reason for a host that is blocked by its spelling alone; null for a name DNS must decide. */
export function literalHostReason(hostname: string): BlockedRange | null {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return "loopback";
  return net.isIP(hostname) ? blockedAddressReason(hostname) : null;
}

export type ResolveHost = (hostname: string) => Promise<string[]>;

export const resolveHost: ResolveHost = async (hostname) =>
  (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

export interface WebhookTargetPolicy {
  isSelf?: (url: URL) => boolean;
  resolve?: ResolveHost;
  /** Hosts (as written in the URL) exempt from the address check; `"*"` exempts all. */
  allowedPrivateHosts?: readonly string[];
  /** Give up on the DNS lookup after this long and refuse the target (default 10 s). */
  lookupTimeoutMs?: number;
}

async function lookupWithTimeout(
  resolve: ResolveHost,
  host: string,
  timeoutMs: number,
): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error("timeout"), { code: "timeout" })),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([resolve(host), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is `raw` an acceptable webhook target? A bad URL, protocol or the server itself throws
 * (`assertWebhookUrl`); a blocked or unresolvable address answers `{ ok: false }`.
 *
 * Residual risk: `fetch` resolves the name again on its own, so a record with TTL 0 can answer
 * differently from the lookup here (DNS rebinding). Pinning the connection to the checked
 * address needs undici's `Agent({ connect: { lookup } })`, a new dependency: a follow-up goal.
 */
export async function checkWebhookTarget(
  raw: string,
  policy: WebhookTargetPolicy,
): Promise<{ ok: true; url: URL; addresses: string[] } | { ok: false; reason: string }> {
  const url = assertWebhookUrl(raw, policy.isSelf);
  const host = hostnameOf(url);
  const allowed = policy.allowedPrivateHosts ?? [];
  if (allowed.some((a) => a === "*" || a.toLowerCase().replace(/^\[|\]$/g, "") === host)) {
    return { ok: true, url, addresses: [] };
  }
  const literal = literalHostReason(host);
  if (literal) return { ok: false, reason: `${host} is ${literal}` };
  if (net.isIP(host)) return { ok: true, url, addresses: [host] };
  let addresses: string[];
  try {
    addresses = await lookupWithTimeout(
      policy.resolve ?? resolveHost,
      host,
      policy.lookupTimeoutMs ?? 10_000,
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { ok: false, reason: `${host} does not resolve (${e.code ?? e.message})` };
  }
  if (addresses.length === 0) return { ok: false, reason: `${host} does not resolve (no address)` };
  for (const address of addresses) {
    const reason = blockedAddressReason(address);
    if (reason) return { ok: false, reason: `${address} is ${reason}` };
  }
  return { ok: true, url, addresses };
}

/** `checkWebhookTarget` that throws a 400 `OpError` for a blocked target. */
export async function assertWebhookTarget(
  raw: string,
  policy: WebhookTargetPolicy,
): Promise<{ url: URL; addresses: string[] }> {
  const target = await checkWebhookTarget(raw, policy);
  if (!target.ok) {
    throw new OpError(
      400,
      `The webhook URL points at a blocked address: ${target.reason}; list the host in security.allowedPrivateWebhookHosts to allow it`,
      "invalid_input",
      [{ path: "url", message: target.reason }],
    );
  }
  return target;
}
