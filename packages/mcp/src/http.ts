import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createBoofMcpServer, type BoofMcpOptions } from "./server.js";

/**
 * Serve one Streamable HTTP request in stateless mode: a fresh server and transport per
 * request, JSON responses, no session table. The caller (the web app) has already
 * authenticated, rate limited and checked Host and Origin.
 */
export async function handleMcpHttp(
  request: Request,
  options: BoofMcpOptions & { parsedBody?: unknown },
): Promise<Response> {
  const { parsedBody, ...serverOptions } = options;
  const server = createBoofMcpServer(serverOptions);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, parsedBody === undefined ? {} : { parsedBody });
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
