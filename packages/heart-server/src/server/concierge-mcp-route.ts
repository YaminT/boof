import type { Context } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ConciergeBridgeRegistry } from "../concierge/bridge.js";
import { PROXY_HEADERS, isLoopbackAddress, type PeerAddressResolver } from "./middleware/auth.js";

export interface ConciergeMcpRouteDeps {
  bridge: () => ConciergeBridgeRegistry;
  peerAddress: PeerAddressResolver;
}

const rpcError = (c: Context, status: 400 | 401 | 403 | 405, code: number, message: string) =>
  c.json({ jsonrpc: "2.0", error: { code, message }, id: null }, status);

/**
 * `/mcp/concierge/:turnId`: the loopback MCP endpoint of one assistant turn, for the claude CLI.
 * It sits outside the API-key chain. Its only credential is the per-turn bearer token, and it
 * answers only a direct loopback peer (a request that came through a proxy is refused). An
 * unknown turn, a finished turn and a wrong token all give the same 401.
 */
export function conciergeMcpRoute(deps: ConciergeMcpRouteDeps) {
  return async (c: Context): Promise<Response> => {
    if (c.req.method !== "POST") {
      c.header("Allow", "POST");
      return rpcError(c, 405, -32000, "Method not allowed: use POST");
    }
    if (
      !isLoopbackAddress(deps.peerAddress(c)) ||
      PROXY_HEADERS.some((name) => c.req.header(name) !== undefined)
    )
      return rpcError(c, 403, -32000, "This endpoint answers local requests only");
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer ([0-9a-f]{64})$/.exec(header);
    const make = deps.bridge().verify(c.req.param("turnId") ?? "", match?.[1]);
    if (!make) return rpcError(c, 401, -32001, "Unauthorized");
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return rpcError(c, 400, -32700, "Parse error: invalid JSON");
    }
    if (Array.isArray(body)) return rpcError(c, 400, -32600, "JSON-RPC batches are not supported");
    // Stateless, like /mcp: a fresh server and transport per request. The gate and the pending
    // counters live in the closure `make` captured, so they are shared across requests of a turn.
    const server = make();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw, { parsedBody: body });
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  };
}
