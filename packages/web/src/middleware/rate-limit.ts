import type { Context, MiddlewareHandler } from "hono";
import type { SecuritySettings } from "@boof-runner/shared";
import type { PeerAddressResolver } from "./auth.js";
import { clientAddress } from "./client-address.js";

const MAX_BUCKETS = 10_000;

interface Bucket {
  tokens: number;
  updated: number;
}

const isAttachmentUpload = (method: string, path: string) =>
  method === "POST" &&
  /^\/api\/(v1\/)?(projects\/[^/]+\/)?tasks\/[^/]+\/attachments\/?$/.test(path);

/** Refill `b` to time `t`; when it holds a token, spend one (if `charge`), else return the Retry-After seconds. */
function take(b: Bucket, limit: number, t: number, charge: boolean): number | undefined {
  b.tokens = Math.min(limit, b.tokens + ((t - b.updated) / 60_000) * limit);
  b.updated = t;
  if (b.tokens < 1) return Math.max(1, Math.ceil(((1 - b.tokens) / limit) * 60));
  if (charge) b.tokens -= 1;
  return undefined;
}

const limited = (c: Context, retryAfter: number) => {
  c.header("Retry-After", String(retryAfter));
  return c.json(
    { error: { code: "rate_limited", message: "Too many requests", details: { retryAfter } } },
    429,
  );
};

/**
 * In-memory token bucket per principal (capacity = limit per minute, refilled
 * continuously). Attachment uploads draw from their own bucket. The SSE stream
 * is one long request and is excluded.
 */
export function rateLimit(opts: {
  security: () => Promise<SecuritySettings>;
  now?: () => number;
}): MiddlewareHandler {
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, Bucket>();

  return async (c, next) => {
    if (c.req.path === "/api/events" || c.req.path === "/api/v1/events") return next();
    const { rateLimit: cfg } = await opts.security();
    const attach = isAttachmentUpload(c.req.method, c.req.path);
    const limit = attach ? cfg.attachmentsPerMinute : cfg.perMinute;
    const key = `${c.get("principal").id}${attach ? ":attachments" : ""}`;
    const t = now();
    const b = buckets.get(key) ?? { tokens: limit, updated: t };
    const retryAfter = take(b, limit, t, true);
    buckets.set(key, b);
    if (retryAfter) return limited(c, retryAfter);
    return next();
  };
}

/**
 * Failed authentications per client address, mounted before `authenticate`. A token is taken
 * before the request runs (a parallel burst cannot slip past) and refunded unless the answer is
 * 401, so a valid key never draws; the request is refused (429) when the bucket is empty. See `clientAddress` for how the address is chosen behind a proxy.
 */
export function unauthenticatedRateLimit(opts: {
  security: () => Promise<SecuritySettings>;
  peerAddress: PeerAddressResolver;
  now?: () => number;
  /** Cap on tracked addresses (default 10 000); beyond it full buckets are swept, then the oldest evicted. */
  maxBuckets?: number;
}): MiddlewareHandler & { size: () => number } {
  const now = opts.now ?? Date.now;
  const maxBuckets = opts.maxBuckets ?? MAX_BUCKETS;
  const buckets = new Map<string, Bucket>();

  /** Drop buckets that have fully refilled; if still over the cap, evict the oldest inserted. */
  const sweep = (limit: number, t: number) => {
    for (const [k, b] of buckets) {
      if (b.tokens + ((t - b.updated) / 60_000) * limit >= limit) buckets.delete(k);
    }
    for (const k of buckets.keys()) {
      if (buckets.size <= maxBuckets) break;
      buckets.delete(k);
    }
  };

  const handler: MiddlewareHandler = async (c, next) => {
    const cfg = await opts.security();
    const limit = cfg.rateLimit.unauthenticatedPerMinute;
    const peer = opts.peerAddress(c);
    const addr = clientAddress((n) => c.req.header(n), peer, cfg.trustedProxies);
    c.set("peerAddress", peer);
    c.set("clientAddress", addr);
    const t = now();
    const b = buckets.get(addr.key) ?? { tokens: limit, updated: t };
    // Take the token before the request runs, so a parallel burst cannot all pass the check.
    const retryAfter = take(b, limit, t, true);
    if (retryAfter) return limited(c, retryAfter);
    if (!buckets.has(addr.key)) {
      buckets.set(addr.key, b);
      if (buckets.size > maxBuckets) sweep(limit, t);
    }
    await next();
    if (c.res.status !== 401) {
      // Not a failed authentication: give the token back; a full bucket is dropped.
      b.tokens = Math.min(limit, b.tokens + 1);
      if (b.tokens >= limit && buckets.get(addr.key) === b) buckets.delete(addr.key);
    }
  };
  return Object.assign(handler, { size: () => buckets.size });
}
