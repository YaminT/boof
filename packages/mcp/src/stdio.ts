import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TaskService } from "@boof-runner/api";
import {
  AuthStore,
  LOCAL_PRINCIPAL,
  mcpSettings,
  securitySettings,
  type Client,
  type Principal,
} from "@boof-runner/shared";
import { createBoofMcpServer } from "./server.js";

export class McpStartError extends Error {}

export function principalFromClient(client: Client): Principal {
  return {
    kind: "client",
    id: client.id,
    name: client.name,
    scopes: new Set(client.scopes),
    projects: client.projects === "*" ? "*" : new Set(client.projects),
    trust: client.trust,
    clientKind: client.kind,
  };
}

export interface StdioOptions {
  root: string;
  /** API client id; its scopes, projects and trust apply. No key is needed (the OS user owns the data root). */
  client?: string;
  /** Serve one project only and hide the `projectId` argument. */
  project?: string;
}

/**
 * Check the options and return the principal resolver for a stdio server. Without `--client` the
 * local (admin) principal is used, and only when `security.auth.mode` is `local-trust`.
 */
export async function stdioPrincipal(
  services: TaskService,
  authStore: AuthStore,
  opts: StdioOptions,
): Promise<() => Promise<Principal>> {
  const settings = await services.loadSettings();
  if (!mcpSettings(settings).enabled) {
    throw new McpStartError("MCP is disabled (settings.mcp.enabled is false)");
  }
  const resolveClient = async (id: string): Promise<Principal> => {
    const client = await authStore.get(id);
    if (!client) throw new McpStartError(`unknown client: ${id}`);
    if (client.revokedAt) throw new McpStartError(`client ${id} is revoked`);
    if (client.expiresAt && Date.parse(client.expiresAt) <= Date.now()) {
      throw new McpStartError(`client ${id} has expired`);
    }
    return principalFromClient(client);
  };
  if (opts.client !== undefined) {
    const id = opts.client;
    await resolveClient(id); // fail at start, not on the first call
    return () => resolveClient(id);
  }
  if (securitySettings(settings).auth.mode !== "local-trust") {
    throw new McpStartError(
      'security.auth.mode is "required": pass --client <id> (create one with "boof-runner auth add")',
    );
  }
  return async () => LOCAL_PRINCIPAL;
}

/** Run the MCP server on stdin/stdout until the host closes the pipe. Logs go to stderr only. */
export async function runStdio(opts: StdioOptions): Promise<void> {
  // stdout carries the protocol: nothing else may write to it.
  console.log = (...args: unknown[]) => console.error(...args);
  const services = new TaskService(opts.root);
  const authStore = new AuthStore(opts.root);
  const principal = await stdioPrincipal(services, authStore, opts);
  if (opts.project !== undefined) await services.requireProject(opts.project);
  const server = createBoofMcpServer({
    root: opts.root,
    principal,
    services,
    authStore,
    project: opts.project,
  });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve;
  });
  await server.connect(transport);
  console.error(
    `boof-runner mcp: serving ${opts.root}${opts.client ? ` as ${opts.client}` : ""}${opts.project ? ` (project ${opts.project})` : ""}`,
  );
  process.stdin.on("end", () => void server.close());
  await closed;
}
