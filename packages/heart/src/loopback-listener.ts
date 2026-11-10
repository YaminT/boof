/**
 * Who is listening on a loopback port, from `/proc/net/tcp` and `/proc/net/tcp6`.
 *
 * Any user can read those tables. The `uid` column is the socket owner (`sock_i_uid`), so this
 * does not need to open another user's `/proc/<pid>`. The address words are the kernel's
 * host-endian print of the network-order address; the port is already in host order (`ntohs`).
 * macOS and Windows have no `/proc/net/tcp`. Callers skip the check there.
 *
 * An exact bind (127.0.0.1, ::1, or the IPv4-mapped form) wins over a wildcard, which is how
 * Linux delivers the connection. A v6 wildcard (`::`) is treated as covering IPv4 too: that is
 * the default (`bindv6only=0`), and the table does not say otherwise.
 */
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { endianness, networkInterfaces } from "node:os";

export interface ListenerLookupDeps {
  platform?: NodeJS.Platform;
  /** Read a file as text, or null. Default: `readFileSync`. */
  readFile?: (path: string) => string | null;
  /** Current user. Default: `process.getuid()`. */
  uid?: number;
  /** How `/proc` printed the address words. Default: this machine. Tests pin `LE`. */
  endian?: "LE" | "BE";
  /** Resolve a hostname when the caller has no addresses yet. Default: `dns.lookup`. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /**
   * Addresses of this machine, besides loopback. Default: `os.networkInterfaces()`.
   * A non-loopback target is checked only when it is one of these.
   */
  localAddresses?: readonly string[];
}

export type ListenerLookup =
  { kind: "skip" } | { kind: "unreadable" } | { kind: "none" } | { kind: "uids"; uids: number[] };

const defaultRead = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

type Ip = { v: 4; b: number[] } | { v: 6; b: number[] };

interface Sock {
  family: 4 | 6;
  ip: number[];
  port: number;
  uid: number;
}

const same = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

const isUnspec6 = (b: readonly number[]): boolean =>
  b.length === 16 && b.every((byte) => byte === 0);

/** `::ffff:a.b.c.d` as four IPv4 bytes, or null. */
function mappedV4(b: readonly number[]): number[] | null {
  if (b.length !== 16) return null;
  for (let i = 0; i < 10; i++) if (b[i] !== 0) return null;
  if (b[10] !== 0xff || b[11] !== 0xff) return null;
  return b.slice(12);
}

function wordToBytes(hex8: string, endian: "LE" | "BE"): number[] | null {
  if (!/^[0-9a-f]{8}$/i.test(hex8)) return null;
  const word = parseInt(hex8, 16);
  const printed = [(word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255];
  return endian === "LE" ? [printed[3]!, printed[2]!, printed[1]!, printed[0]!] : printed;
}

function parseV4(hex: string, endian: "LE" | "BE"): number[] | null {
  return wordToBytes(hex, endian);
}

function parseV6(hex: string, endian: "LE" | "BE"): number[] | null {
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < 4; i++) {
    const word = wordToBytes(hex.slice(i * 8, i * 8 + 8), endian);
    if (!word) return null;
    bytes.push(...word);
  }
  return bytes;
}

/** Eight groups of an IPv6 address, including a dotted-quad tail and `::`. */
function ipv6Bytes(address: string): number[] | null {
  let text = address.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const parts = dotted.slice(1).map(Number);
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const [a, b, c, d] = parts as [number, number, number, number];
    text =
      text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const front = halves[0] ? halves[0].split(":") : [];
  const back = halves.length === 1 ? [] : halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && front.length !== 8) return null;
  const missing = 8 - front.length - back.length;
  if (missing < 0) return null;
  const groups = [...front, ...Array<string>(missing).fill("0"), ...back];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const n = parseInt(group, 16);
    bytes.push((n >> 8) & 255, n & 255);
  }
  return bytes;
}

function parseUserIp(address: string): Ip | null {
  const text = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (isIP(text) === 4) {
    const b = text.split(".").map(Number);
    if (b.length !== 4 || b.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return { v: 4, b };
  }
  if (isIP(text) !== 6) return null;
  const bytes = ipv6Bytes(text);
  if (!bytes) return null;
  const mapped = mappedV4(bytes);
  return mapped ? { v: 4, b: mapped } : { v: 6, b: bytes };
}

/** True for 127.0.0.0/8, `::1`, and IPv4-mapped loopback. `localhost` counts too. */
export function isLoopbackAddress(address: string): boolean {
  if (address.trim().toLowerCase() === "localhost") return true;
  const ip = parseUserIp(address);
  if (!ip) return false;
  if (ip.v === 4) return ip.b[0] === 127;
  return ip.b.every((byte, i) => byte === (i === 15 ? 1 : 0));
}

function parseTable(text: string, family: 4 | 6, endian: "LE" | "BE"): Sock[] {
  const sockets: Sock[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8 || !parts[0]?.endsWith(":")) continue;
    const local = parts[1];
    const state = parts[3];
    const uid = Number(parts[7]);
    if (!local || state?.toUpperCase() !== "0A" || !Number.isInteger(uid) || uid < 0) continue;
    const colon = local.lastIndexOf(":");
    if (colon <= 0) continue;
    const port = parseInt(local.slice(colon + 1), 16);
    if (!Number.isInteger(port) || port < 0 || port > 65535) continue;
    const ip =
      family === 4
        ? parseV4(local.slice(0, colon), endian)
        : parseV6(local.slice(0, colon), endian);
    if (!ip) continue;
    sockets.push({ family, ip, port, uid });
  }
  return sockets;
}

const isExact = (sock: Sock, dest: Ip): boolean => {
  if (dest.v === 4) {
    if (sock.family === 4) return same(sock.ip, dest.b);
    const mapped = mappedV4(sock.ip);
    return mapped !== null && same(mapped, dest.b);
  }
  return sock.family === 6 && same(sock.ip, dest.b);
};

/** Wildcard that would accept `dest` when nothing is bound to the address itself. */
const isWild = (sock: Sock, dest: Ip): boolean => {
  if (dest.v === 4) {
    if (sock.family === 4) return same(sock.ip, [0, 0, 0, 0]);
    return sock.family === 6 && isUnspec6(sock.ip);
  }
  return sock.family === 6 && isUnspec6(sock.ip);
};

/**
 * Uids of the listening sockets that would accept a connection to `address`:`port`.
 * `skip` on anything other than Linux. `unreadable` when either proc table cannot be read.
 * `none` when Linux shows no such listener. An unparseable address is `none`.
 */
export function loopbackListenerUids(
  address: string,
  port: number,
  deps: ListenerLookupDeps = {},
): ListenerLookup {
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") return { kind: "skip" };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { kind: "none" };
  const readFile = deps.readFile ?? defaultRead;
  const endian = deps.endian ?? (endianness() === "BE" ? "BE" : "LE");
  const tcp = readFile("/proc/net/tcp");
  const tcp6 = readFile("/proc/net/tcp6");
  if (tcp === null || tcp6 === null) return { kind: "unreadable" };
  const dest = parseUserIp(address);
  if (!dest) return { kind: "none" };
  const sockets = [...parseTable(tcp, 4, endian), ...parseTable(tcp6, 6, endian)].filter(
    (sock) => sock.port === port,
  );
  const exact = sockets.filter((sock) => isExact(sock, dest));
  const chosen = exact.length > 0 ? exact : sockets.filter((sock) => isWild(sock, dest));
  const uids = [...new Set(chosen.map((sock) => sock.uid))];
  return uids.length === 0 ? { kind: "none" } : { kind: "uids", uids };
}

const currentUid = (deps: ListenerLookupDeps): number | undefined => deps.uid ?? process.getuid?.();

/**
 * `open` on Linux: a message when the link must not be printed. Null only when every address
 * the link would use has listeners and each of them is this user. Nothing listening is a
 * refusal, as is another uid (including root: boof's own server runs as the owner) or a table
 * that cannot be read. Other platforms skip the check.
 */
export function openLoopbackRefusal(
  host: string,
  port: number,
  deps: ListenerLookupDeps = {},
): string | null {
  if ((deps.platform ?? process.platform) !== "linux") return null;
  const uid = currentUid(deps);
  if (uid === undefined)
    return `cannot see who is listening on port ${port}; not printing a sign-in link`;
  const addresses =
    host === "localhost"
      ? ["127.0.0.1", "::1"]
      : host === "::1" || host === "[::1]"
        ? ["::1"]
        : [host];
  let nothing = false;
  for (const address of addresses) {
    const found = loopbackListenerUids(address, port, deps);
    if (found.kind === "unreadable")
      return `cannot see who is listening on port ${port}; not printing a sign-in link`;
    if (found.kind !== "uids") {
      nothing = true;
      continue;
    }
    const foreign = found.uids.filter((id) => id !== uid);
    if (foreign.length > 0) return `port ${port} is held by uid ${foreign[0]}, not by your boof`;
  }
  return nothing ? `nothing is listening on port ${port}; start boof first` : null;
}

/**
 * Before an n8n credential goes to a loopback address on Linux. Null when the send may proceed:
 * not Linux, not loopback, or the listener is this user or root (`docker-proxy`).
 * `retryable` is true only when nothing is listening, so a restarting n8n can be tried again
 * without the secret having been sent.
 */
export function n8nLoopbackRefusal(
  address: string,
  port: number,
  deps: ListenerLookupDeps = {},
): { reason: string; retryable: boolean } | null {
  if (!isLoopbackAddress(address)) return null;
  return localListenerRefusal(address, port, deps);
}

/** Linux uid check for one address. Null when the listener is this user or root, or this is not Linux. */
function localListenerRefusal(
  address: string,
  port: number,
  deps: ListenerLookupDeps,
): { reason: string; retryable: boolean } | null {
  if ((deps.platform ?? process.platform) !== "linux") return null;
  const uid = currentUid(deps);
  const where = `${address}:${port}`;
  if (uid === undefined)
    return {
      reason: `listener_not_owner: cannot see who is listening on ${where}`,
      retryable: false,
    };
  const found = loopbackListenerUids(address, port, deps);
  if (found.kind === "skip") return null;
  if (found.kind === "unreadable")
    return {
      reason: `listener_not_owner: cannot see who is listening on ${where}`,
      retryable: false,
    };
  if (found.kind === "none")
    return {
      reason: `listener_not_owner: nothing owned by uid ${uid} is listening on ${where}`,
      retryable: true,
    };
  const allowed = new Set([uid, 0]);
  const foreign = found.uids.filter((id) => !allowed.has(id));
  if (foreign.length > 0)
    return {
      reason: `listener_not_owner: port ${port} on ${address} is held by uid ${foreign.join(",")}, not by uid ${uid}`,
      retryable: false,
    };
  return null;
}

/** Port of an http(s) URL. A missing port is 80 or 443. */
function urlPort(url: URL): number {
  if (url.port) {
    const n = Number(url.port);
    return Number.isInteger(n) ? n : NaN;
  }
  return url.protocol === "https:" ? 443 : 80;
}

/** Strip brackets and an IPv6 zone id. `::ffff:a.b.c.d` stays so the lookup can see it. */
function normalizeAddress(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .split("%")[0]!;
}

/** `::ffff:a.b.c.d` as the IPv4 address; anything else unchanged. */
function unwrapMapped(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  return mapped?.[1] ?? address;
}

function machineAddresses(deps: ListenerLookupDeps): Set<string> {
  const listed = deps.localAddresses ?? defaultMachineAddresses();
  const found = new Set<string>();
  for (const raw of listed) {
    const address = unwrapMapped(normalizeAddress(raw));
    if (address) found.add(address);
  }
  return found;
}

function defaultMachineAddresses(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.address) found.push(entry.address);
    }
  }
  return found;
}

/** Loopback, or an address configured on this machine. Remote private addresses are not. */
function isThisHost(address: string, local: ReadonlySet<string>): boolean {
  if (isLoopbackAddress(address)) return true;
  const plain = unwrapMapped(normalizeAddress(address));
  return local.has(plain);
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const found = await lookup(hostname, { all: true, verbatim: true });
  return found.map((item) => item.address);
}

/**
 * Addresses the connection would use. When the caller has none and the host is a name, resolve
 * it here so the listener check and the later pin see the same list.
 */
async function sendCandidates(
  url: URL,
  addresses: readonly string[],
  deps: ListenerLookupDeps,
): Promise<string[] | { reason: string; retryable: boolean }> {
  const candidates: string[] = [];
  const push = (raw: string) => {
    const address = normalizeAddress(raw);
    if (!address || address === "localhost" || !isIP(address)) return;
    if (!candidates.includes(address)) candidates.push(address);
  };
  push(url.hostname);
  for (const address of addresses) push(address);
  if (candidates.length > 0) return candidates;
  const host = normalizeAddress(url.hostname);
  if (!host || isIP(host)) return candidates;
  try {
    const resolved = await (deps.resolveHost ?? defaultResolveHost)(host);
    for (const address of resolved) push(address);
  } catch {
    return { reason: `listener_not_owner: ${host} does not resolve`, retryable: true };
  }
  if (candidates.length === 0)
    return { reason: `listener_not_owner: ${host} does not resolve`, retryable: true };
  return candidates;
}

export type N8nSendDecision =
  { ok: true; addresses: readonly string[] } | { ok: false; reason: string; retryable: boolean };

/**
 * Before an n8n API key, webhook secret or run token is sent to `url`.
 * On Linux, every loopback address and every address of this host is checked. `localhost` and
 * any other name with an empty address list is resolved here, not left for a later lookup.
 * `ok` carries only the addresses the request may connect to: a local address with no listener
 * is left out, and a foreign uid or an unreadable table refuses the send. Off Linux the caller's
 * list is returned unchanged. `retryable` only when nothing is listening or the name did not
 * resolve, so a restarting n8n can be tried again without the secret having been sent.
 */
export async function n8nSendRefusal(
  url: URL,
  addresses: readonly string[],
  deps: ListenerLookupDeps = {},
): Promise<N8nSendDecision> {
  const port = urlPort(url);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: true, addresses };
  if ((deps.platform ?? process.platform) !== "linux") return { ok: true, addresses };
  const candidates = await sendCandidates(url, addresses, deps);
  if (!Array.isArray(candidates)) return { ok: false, ...candidates };
  const local = machineAddresses(deps);
  const pinned: string[] = [];
  let none: { reason: string; retryable: boolean } | null = null;
  for (const address of candidates) {
    if (!isThisHost(address, local)) {
      pinned.push(address);
      continue;
    }
    const found = localListenerRefusal(address, port, deps);
    if (!found) {
      pinned.push(address);
      continue;
    }
    if (!found.retryable) return { ok: false, reason: found.reason, retryable: false };
    none = found;
  }
  if (pinned.length > 0) return { ok: true, addresses: pinned };
  if (none) return { ok: false, reason: none.reason, retryable: none.retryable };
  const uid = currentUid(deps);
  return {
    ok: false,
    reason: `listener_not_owner: nothing owned by uid ${uid ?? "unknown"} is listening on ${url.host}`,
    retryable: true,
  };
}
