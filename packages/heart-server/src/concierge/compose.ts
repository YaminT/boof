import type { ConciergeAgent } from "@boof/heart";
import { getOp, registry } from "../api/registry.js";
import type { TaskService } from "../api/services/service.js";
import { createConciergeMcpServer } from "../mcp/server.js";
import { ConciergeService } from "./service.js";

/**
 * Build the assistant service with the operation registry and the concierge MCP server.
 * Those modules import TaskService, so TaskService cannot import them. The server and the CLI
 * call this when they assemble a TaskService, then pass the result in.
 */
export function attachConcierge(
  service: TaskService,
  agent: ConciergeAgent | null = service.conciergeAgent,
): ConciergeService {
  const concierge = new ConciergeService({
    root: service.root,
    services: service,
    authStore: service.authStore,
    agent,
    registry,
    getOp,
    createMcpServer: createConciergeMcpServer,
  });
  service.useConcierge(concierge);
  return concierge;
}
