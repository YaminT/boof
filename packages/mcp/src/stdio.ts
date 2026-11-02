import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  LocalPrincipalError,
  localPrincipal,
  principalFromClient,
  TaskService,
} from "@boof-runner/api";
import { AuthStore, mcpSettings, type Principal } from "@boof-runner/shared";
import { createBoofMcpServer } from "./server.js";

export class McpStartError extends Error {}

export { principalFromClient };

export interface StdioOptions {
  root: string;
  /** API client id; its scopes, projects and trust apply. No key is needed (the OS user owns the data root). */
  client?: string;
  /** Serve one project only and hide the `projectId` argument. */
  project?: string;
  /**
   * Without `client`: also list the administration tools (API clients, webhooks, settings writes,
   * commands, project deletion). Default false. With `client` the client's scopes decide.
   */
  admin?: boolean;
}

/**
 * Check the options and return the principal for a stdio server. Without `--client` it is the
 * review-trust `local-mcp` principal (the local administrator with `--admin`), and only when
 * `security.auth.mode` is `local-trust`.
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
  // One identity rule for every local surface; its refusals are start errors here.
  const asStartError = (err: unknown): never => {
    throw err instanceof LocalPrincipalError ? new McpStartError(err.message) : err;
  };
  // Without a client and without --admin the host acts like a review-trust client.
  const resolve = await localPrincipal({
    settings,
    authStore,
    client: opts.client,
    withoutClient: opts.admin ? "admin" : "review",
  }).catch(asStartError);
  return () => resolve().catch(asStartError);
}

/** What {@link closeWhenDrained} needs of a transport; the SDK's stdio transport satisfies it. */
export interface DrainTransport {
  send(message: JSONRPCMessage): Promise<void>;
  onmessage?: (message: JSONRPCMessage) => void;
}

/**
 * Requests are answered asynchronously. When the host closes stdin right after writing them,
 * close only once every request received has been answered (or cancelled: the SDK sends no reply
 * for a cancelled request), or the replies are dropped. Call after the server connected to
 * `transport`; `stdinEnded` starts the drain.
 */
export function closeWhenDrained(
  transport: DrainTransport,
  close: () => void,
): { stdinEnded: () => void } {
  const pending = new Set<unknown>();
  let ended = false;
  const check = () => {
    if (ended && pending.size === 0) close();
  };
  const send = transport.send.bind(transport);
  transport.send = async (message: JSONRPCMessage) => {
    await send(message);
    if ("id" in message && !("method" in message)) pending.delete(message.id);
    check();
  };
  const onmessage = transport.onmessage;
  transport.onmessage = (message: JSONRPCMessage) => {
    if ("id" in message && "method" in message) pending.add(message.id);
    if (!("id" in message) && "method" in message && message.method === "notifications/cancelled") {
      const requestId = (message.params as { requestId?: unknown } | undefined)?.requestId;
      if (requestId !== undefined) pending.delete(requestId);
    }
    onmessage?.(message);
    check();
  };
  return {
    stdinEnded: () => {
      ended = true;
      check();
    },
  };
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
    // The keyless stdio server is `local-mcp` unless `--admin`: its default hides the administration tools.
    ...(opts.client === undefined ? { adminTools: opts.admin === true } : {}),
  });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve;
  });
  await server.connect(transport);
  const drain = closeWhenDrained(transport, () => void server.close());
  console.error(
    `boof-runner mcp: serving ${opts.root}${opts.client ? ` as ${opts.client}` : ""}${opts.project ? ` (project ${opts.project})` : ""}`,
  );
  process.stdin.on("end", drain.stdinEnded);
  await closed;
}
