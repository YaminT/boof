import type { MiddlewareHandler } from "hono";
import { appendAuditLine, type SecuritySettings } from "@boof-runner/shared";
import { clientAddress } from "./client-address.js";

/**
 * Append one JSON line per /api request to <data>/audit/<YYYY-MM-DD>.jsonl.
 * Records who, what, outcome and timing. Never request bodies, prompts or keys.
 * Placed outermost so rejected requests (401/403/429) are logged too.
 */
export function audit(opts: {
  root: string;
  security: () => Promise<SecuritySettings>;
  now?: () => number;
}): MiddlewareHandler {
  const now = opts.now ?? Date.now;
  return async (c, next) => {
    const start = now();
    try {
      await next();
    } finally {
      try {
        const security = await opts.security();
        const cfg = security.audit;
        if (cfg.enabled) {
          const principal = c.get("principal");
          const id = c.req.param("id") ?? c.req.param("taskId");
          const name = c.req.param("name") ?? c.req.param("attachmentName");
          const project = c.req.param("pid") ?? c.req.param("projectId");
          const addr =
            c.get("clientAddress") ??
            clientAddress((n) => c.req.header(n), c.get("peerAddress"), security.trustedProxies);
          const line = {
            ts: new Date(start).toISOString(),
            principal: principal?.id ?? "anonymous",
            kind: principal?.kind ?? "anonymous",
            action: `${c.req.method} ${c.req.routePath}`,
            ...(project ? { project } : {}),
            ...(id ? { target: name ? `${id}/${name}` : id } : {}),
            status: c.res.status,
            ms: now() - start,
            ip: c.get("peerAddress") ?? null,
            ...(addr.forwardedFor ? { forwardedFor: addr.forwardedFor } : {}),
            ...c.get("auditExtra"),
          };
          await appendAuditLine(opts.root, line);
        }
      } catch (err) {
        console.error("audit write failed", err);
      }
    }
  };
}

export { pruneAudit } from "@boof-runner/shared";
