import type { MiddlewareHandler } from "hono";
import type { SecuritySettings } from "@boof-runner/shared";

interface Bucket {
  tokens: number;
  updated: number;
}

const isAttachmentUpload = (method: string, path: string) =>
  method === "POST" && /^\/api\/tasks\/[^/]+\/attachments\/?$/.test(path);

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
    if (c.req.path === "/api/events") return next();
    const { rateLimit: cfg } = await opts.security();
    const attach = isAttachmentUpload(c.req.method, c.req.path);
    const limit = attach ? cfg.attachmentsPerMinute : cfg.perMinute;
    const key = `${c.get("principal").id}${attach ? ":attachments" : ""}`;
    const t = now();
    const b = buckets.get(key) ?? { tokens: limit, updated: t };
    b.tokens = Math.min(limit, b.tokens + ((t - b.updated) / 60_000) * limit);
    b.updated = t;
    if (b.tokens < 1) {
      buckets.set(key, b);
      const retryAfter = Math.max(1, Math.ceil(((1 - b.tokens) / limit) * 60));
      c.header("Retry-After", String(retryAfter));
      return c.json(
        { error: { code: "rate_limited", message: "Too many requests", details: { retryAfter } } },
        429,
      );
    }
    b.tokens -= 1;
    buckets.set(key, b);
    return next();
  };
}
