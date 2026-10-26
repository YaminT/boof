import type { Context } from "hono";
import { handleMcpHttp } from "@boof-runner/mcp";
import { mcpSettings, type AuthStore } from "@boof-runner/shared";
import type { TaskService } from "@boof-runner/api";

export interface McpRouteDeps {
  service: TaskService;
  /** The same client registry the authenticator uses, so revocations apply at once. */
  authStore: AuthStore;
}

const rpcError = (c: Context, status: 400 | 404 | 405, code: number, message: string) =>
  c.json({ jsonrpc: "2.0", error: { code, message }, id: null }, status);

/**
 * `/mcp`: MCP over Streamable HTTP in stateless mode (POST; GET and DELETE answer 405 because there are no sessions). Runs after the security
 * chain (Host guard, body limit, Origin check, authentication, rate limit, audit), so the
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
    const method = (parsedBody as { method?: unknown } | null)?.method;
    if (typeof method === "string" && method !== "tools/call") {
      c.set("auditExtra", { action: `mcp:${method}` });
    }

    return handleMcpHttp(c.req.raw, {
      root: deps.service.root,
      principal: c.get("principal"),
      services: deps.service,
      authStore: deps.authStore,
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
