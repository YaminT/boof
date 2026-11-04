import type { Context } from "hono";
import { handleMcpHttp } from "../mcp/index.js";
import { mcpSettings, type AuthStore } from "@boof/heart";
import type { ResolveHost, TaskService } from "../api/index.js";

export interface McpRouteDeps {
  service: TaskService;
  /** The same client registry the authenticator uses, so revocations apply at once. */
  authStore: AuthStore;
  /** The same self-host and DNS checks the REST routes give operations (webhook targets). */
  isSelfUrl?: (url: URL) => boolean;
  resolveHost?: ResolveHost;
}

const rpcError = (c: Context, status: 400 | 404 | 405, code: number, message: string) =>
  c.json({ jsonrpc: "2.0", error: { code, message }, id: null }, status);

/**
 * `/mcp`: MCP over Streamable HTTP in stateless mode (POST; GET and DELETE answer 405 because there are no sessions). Runs after the security
 * chain (host guard, secure headers (+HSTS), audit, body limit, origin guard, authenticate (the
 * unauthenticated limiter answers 429 on failure), per-principal limiter), so the
 * principal is already on the context. The audit line gets `action: mcp:<tool>` (or
 * `mcp:<method>` for other requests).
 */
export function mcpRoute(deps: McpRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const settings = await deps.service.loadSettings();
    if (!mcpSettings(settings).enabled) {
      return c.json({ error: { code: "not_found", message: "MCP is disabled" } }, 404);
    }

    // Stateless: there are no sessions to close and no server-initiated messages to stream.
    if (c.req.method !== "POST") {
      c.header("Allow", "POST");
      return rpcError(c, 405, -32000, "Method not allowed: this endpoint is stateless, use POST");
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(await c.req.text());
    } catch {
      return rpcError(c, 400, -32700, "Parse error: invalid JSON");
    }
    if (Array.isArray(parsedBody)) {
      return rpcError(
        c,
        400,
        -32600,
        "JSON-RPC batches are not supported on this endpoint: send one request per POST",
      );
    }
    const method = (parsedBody as { method?: unknown } | null)?.method;
    if (typeof method === "string" && method !== "tools/call") {
      c.set("auditExtra", { action: `mcp:${method}` });
    }

    // A keyless loopback caller under local-trust is a model host, not the administrator: the
    // route middleware (app.ts) made it the review-trust `local-mcp` principal; the
    // administration tools are hidden, as on stdio.
    const keyless = c.get("keylessMcp") === true;
    return handleMcpHttp(c.req.raw, {
      root: deps.service.root,
      principal: c.get("principal"),
      ...(keyless ? { adminTools: false } : {}),
      services: deps.service,
      authStore: deps.authStore,
      isSelfUrl: deps.isSelfUrl,
      resolveHost: deps.resolveHost,
      parsedBody,
      onCall: (info) =>
        c.set("auditExtra", {
          action: `mcp:${info.tool}`,
          ...(info.projectId ? { project: info.projectId } : {}),
          ...(info.ok ? {} : { error: info.code }),
        }),
    });
  };
}
