import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  LocalPrincipalError,
  localPrincipal,
  MCP_REVIEW_SCOPES,
  principalFromClient,
  TaskService,
} from "../api/index.js";
import {
  AuthStore,
  auditOperation,
  mcpSettings,
  securitySettings,
  type Principal,
  type Settings,
  type ToolCatalog,
} from "@boof/heart";
import { createSelfUrlCheck } from "../server/self-url.js";
import { createBoofMcpServer, type ToolCallInfo } from "./server.js";

/** What `boof-runner mcp` prints when it is started without `--client`. */
export function mcpNeedsClientMessage(): string {
  return [
    "boof-runner mcp needs --client <id>. Keyless MCP was removed (agent containment).",
    "Create a review-trust client once, then use it:",
    `  boof-runner auth add --name mcp-host --scopes ${MCP_REVIEW_SCOPES.join(",")} --trust review`,
    "  boof-runner mcp --client <the printed id> [--project <id>]",
    "For the administration tools, create a trusted client with the admin scope instead.",
  ].join("\n");
}

/**
 * The audit hook of a stdio server: every tool call appends one line to the audit log, the same
 * log and settings as the web server's (`via: stdio-mcp`; who, tool, project, outcome, timing; no
 * arguments). `flush()` waits for the writes still in flight.
 */
export function stdioAudit(root: string) {
  // One write after another, so the lines keep the order of the calls.
  let tail: Promise<void> = Promise.resolve();
  return {
    onCall(info: ToolCallInfo): void {
      tail = tail.then(() =>
        auditOperation(root, {
          principal: info.principal,
          action: `mcp:${info.tool}`,
          via: "stdio-mcp",
          project: info.projectId,
          ok: info.ok,
          code: info.code,
          ms: info.ms,
          at: info.startedAt,
        }),
      );
    },
    async flush(): Promise<void> {
      await tail;
    },
  };
}

export class McpStartError extends Error {
  /** 3: start MCP differently (no client, the removed `--admin`, a refused client). 1: any other start failure. */
  readonly exitCode: 1 | 3;
  /** True when `message` is complete copy that the CLI prints as is, without its `mcp:` prefix. */
  readonly rawMessage: boolean;
  constructor(message: string, exitCode: 1 | 3 = 1, rawMessage = exitCode === 3) {
    super(message);
    this.exitCode = exitCode;
    this.rawMessage = rawMessage;
  }
}

export { principalFromClient };

export interface StdioOptions {
  root: string;
  /**
   * API client id. Required. Its scopes, projects and trust apply. No key is needed (the OS user
   * owns the data root).
   */
  client: string;
  /** The tools, built by the composition root (bin); MCP never constructs a registry. */
  catalog: ToolCatalog;
  /** Serve one project only and hide the `projectId` argument. */
  project?: string;
  /** Off-to-enforce writes run this first. The composition root supplies it. */
  assessSandbox?: () => Promise<{ ok: boolean; reason: string }>;
  refreshSandbox?: (settings: Settings) => Promise<void>;
}

/**
 * Check the options and return the principal for a stdio server. `--client` is required: there is
 * no keyless identity. The client's scopes, projects and trust apply, in `local-trust` and in
 * `required` mode.
 */
export async function stdioPrincipal(
  services: TaskService,
  authStore: AuthStore,
  opts: StdioOptions,
): Promise<() => Promise<Principal>> {
  if (!opts.client) throw new McpStartError(mcpNeedsClientMessage(), 3);
  const settings = await services.loadSettings();
  if (!mcpSettings(settings).enabled) {
    throw new McpStartError("MCP is disabled (settings.mcp.enabled is false)");
  }
  // One identity rule for every local surface; its refusals are start errors here.
  const asStartError = (err: unknown): never => {
    throw err instanceof LocalPrincipalError ? new McpStartError(err.message, 3, false) : err;
  };
  const resolve = await localPrincipal({
    settings,
    authStore,
    client: opts.client,
  }).catch(asStartError);
  return () => resolve().catch(asStartError);
}

/** The self-address check of a stdio server: boof's usual port (`BOOF_RUNNER_PORT`) and allowed hosts. */
export async function stdioSelfUrlCheck(
  services: TaskService,
  env: NodeJS.ProcessEnv = process.env,
): Promise<(url: URL) => boolean> {
  const settings = await services.loadSettings();
  return createSelfUrlCheck({
    port: Number(env.BOOF_RUNNER_PORT ?? 4319),
    allowedHosts: securitySettings(settings).allowedHosts,
    callbackBaseUrl: settings.n8n?.callbackBaseUrl,
  });
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
  const services = new TaskService(opts.root, opts.catalog, {
    assessSandbox: opts.assessSandbox,
    refreshSandbox: opts.refreshSandbox,
  });
  const authStore = new AuthStore(opts.root);
  const principal = await stdioPrincipal(services, authStore, opts);
  if (opts.project !== undefined) await services.requireProject(opts.project);
  const auditor = stdioAudit(opts.root);
  const server = createBoofMcpServer({
    onCall: auditor.onCall,
    root: opts.root,
    principal,
    services,
    authStore,
    project: opts.project,
    // The n8n tools refuse without one: boof's own address must never be the n8n host.
    isSelfUrl: await stdioSelfUrlCheck(services),
  });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve;
  });
  await server.connect(transport);
  const drain = closeWhenDrained(transport, () => void server.close());
  console.error(
    `boof-runner mcp: serving ${opts.root} as ${opts.client}${opts.project ? ` (project ${opts.project})` : ""}`,
  );
  process.stdin.on("end", drain.stdinEnded);
  await closed;
  await auditor.flush();
}
