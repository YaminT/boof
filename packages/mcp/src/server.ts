import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  registry,
  toOpError,
  warningsOf,
  TaskService,
  type AnyOperation,
  type OpContext,
  type OpError,
} from "@boof-runner/api";
import {
  authorize,
  BOOF_VERSION,
  type AuthStore,
  type Principal,
  type Scope,
} from "@boof-runner/shared";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";

export const SERVER_NAME = "boof-runner";

/** Cap for the JSON copy in `content` (the full result stays in `structuredContent`). */
const MAX_TEXT_JSON = 200_000;

export interface ToolCallInfo {
  /** The MCP tool name, such as `boof_create_plan`. */
  tool: string;
  principal: Principal;
  projectId?: string;
  ok: boolean;
  /** Error code when `ok` is false. */
  code?: string;
}

export interface BoofMcpOptions {
  /** The data root. */
  root: string;
  /** Resolved for every call, so a revoked client loses access at once (stdio) or per request (HTTP). */
  principal: Principal | (() => Principal | Promise<Principal>);
  services: TaskService;
  authStore: AuthStore;
  /** Fix the project: every project-scoped tool gets this `projectId`, and the argument is hidden. */
  project?: string;
  /**
   * `false` hides the administration tools (API clients, webhooks, settings writes, commands,
   * project deletion). The keyless stdio server sets it unless `--admin` is given; an HTTP server
   * or a stdio server with `--client` leaves it unset and the caller's scopes decide.
   */
  adminTools?: boolean;
  /** Called after every tool call (the HTTP transport records it in the audit log). */
  onCall?: (info: ToolCallInfo) => void;
  /** Operations to serve; default is the whole registry (filtered by `mcp.expose`). */
  ops?: readonly AnyOperation[];
  version?: string;
  now?: () => string;
  /** The HTTP request's signal (stateless HTTP); stdio leaves it unset. */
  signal?: AbortSignal;
}

/** What the server hands to the tool, resource and prompt builders. */
export interface McpRuntime {
  options: BoofMcpOptions;
  ops: readonly AnyOperation[];
  principal(): Promise<Principal>;
  /** Run an operation as the current principal. */
  run(op: AnyOperation, raw: unknown, signal?: AbortSignal): Promise<unknown>;
  op(name: string): AnyOperation;
}

/** Scopes that only the server's administrator holds: API clients and webhooks need one of them. */
export const SERVER_ADMIN_SCOPES: readonly Scope[] = ["admin", "auth:admin"];

/**
 * Operations that change or reveal the server's own configuration, beyond the API-client and
 * webhook operations (which {@link SERVER_ADMIN_SCOPES} select by scope): settings writes, the
 * paid health check, command templates and project deletion. A keyless stdio server hides all of
 * them unless started with `--admin`.
 */
const ADMIN_FLAG_OPS: readonly string[] = [
  "settings.update",
  "settings.checkHealth",
  "commands.create",
  "commands.update",
  "commands.delete",
  "projects.delete",
];

const isServerAdminOp = (o: AnyOperation): boolean =>
  o.scopes.length > 0 && o.scopes.every((s) => SERVER_ADMIN_SCOPES.includes(s));

/**
 * The operations a server offers as tools: the exposed ones, filtered by the caller's scopes at
 * `tools/list`. `--project` also hides project creation and the API-client and webhook tools (a
 * server pinned to one project is a project tool). `adminTools: false` (a keyless stdio server
 * without `--admin`) hides every administration tool; unset or true leaves them to the scopes.
 */
export function exposedOps(
  ops: readonly AnyOperation[],
  opts: { project?: string; adminTools?: boolean } = {},
): AnyOperation[] {
  return ops.filter((o) => {
    if (!o.mcp.expose) return false;
    if (opts.project !== undefined && (o.name === "projects.create" || isServerAdminOp(o))) {
      return false;
    }
    if (opts.adminTools === false && (isServerAdminOp(o) || ADMIN_FLAG_OPS.includes(o.name))) {
      return false;
    }
    return true;
  });
}

type JsonSchema = Record<string, unknown>;

function toJsonSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const json = z.toJSONSchema(schema, { io, unrepresentable: "any", target: "draft-7" });
  delete (json as JsonSchema)["$schema"];
  return json as JsonSchema;
}

/** The input shape a client sees: without `projectId` when the project is fixed. */
function inputSchemaFor(op: AnyOperation, project: string | undefined): JsonSchema {
  const hide = project !== undefined && op.projectScoped;
  const schema = hide ? (op.input as z.ZodObject).omit({ projectId: true }) : op.input;
  return toJsonSchema(schema, "input");
}

/** Build the `tools/list` entry of an operation. */
export function toolDefinition(op: AnyOperation, project?: string): Tool {
  const output = toJsonSchema(op.output, "output");
  return {
    name: op.mcp.name!,
    title: op.title,
    description: op.description,
    inputSchema: inputSchemaFor(op, project) as Tool["inputSchema"],
    ...(output["type"] === "object" ? { outputSchema: output as Tool["outputSchema"] } : {}),
    annotations: { title: op.title, ...op.mcp.annotations },
  };
}

function errorResult(err: OpError): CallToolResult {
  const details = err.details === undefined ? "" : ` ${JSON.stringify(err.details)}`;
  return {
    isError: true,
    content: [{ type: "text", text: `${err.code}: ${err.message}${details}` }],
  };
}

function successResult(op: AnyOperation, result: unknown): CallToolResult {
  const summary = op.summary ? op.summary(result) : "OK";
  let json = JSON.stringify(result);
  if (json.length > MAX_TEXT_JSON) {
    json = `${json.slice(0, MAX_TEXT_JSON)}... (truncated; the full result is in structuredContent)`;
  }
  const structured =
    typeof result === "object" && result !== null && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : undefined;
  const warnings = warningsOf(result).map((w) => ({
    type: "text" as const,
    text: `Warning (${w.code}): ${w.message}`,
  }));
  return {
    content: [{ type: "text", text: summary }, { type: "text", text: json }, ...warnings],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/**
 * Create the MCP server: one tool per exposed registry operation, plus resources and prompts.
 * Every call goes through `op.execute`, so scope checks, input validation, project
 * authorization, trust rules and error codes are exactly those of the REST API.
 */
export function createBoofMcpServer(options: BoofMcpOptions): McpServer {
  const ops = exposedOps(options.ops ?? registry, {
    project: options.project,
    adminTools: options.adminTools,
  });
  const allOps = options.ops ?? registry;
  const byTool = new Map(ops.map((o) => [o.mcp.name!, o]));
  const byName = new Map(allOps.map((o) => [o.name, o]));
  const resolve = async (): Promise<Principal> =>
    typeof options.principal === "function" ? options.principal() : options.principal;

  const run = async (op: AnyOperation, raw: unknown, signal?: AbortSignal): Promise<unknown> => {
    const principal = await resolve();
    const ctx: OpContext = {
      root: options.root,
      principal,
      services: options.services,
      authStore: options.authStore,
      signal:
        options.signal && signal
          ? AbortSignal.any([options.signal, signal])
          : (options.signal ?? signal),
      now: options.now ?? (() => new Date().toISOString()),
    };
    return op.execute(ctx, raw);
  };
  const runtime: McpRuntime = {
    options,
    ops,
    principal: resolve,
    run,
    op: (name) => {
      const op = byName.get(name);
      if (!op) throw new Error(`unknown operation ${name}`);
      return op;
    },
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: options.version ?? BOOF_VERSION },
    {
      instructions:
        "Boof runs coding-agent tasks in git repositories. Typical flow: boof_list_projects, " +
        "boof_create_plan (or boof_import_plan), boof_sync_plan, boof_list_tasks, boof_wait_task, " +
        "boof_wait_plan, boof_get_task. Plan changes take the plan's expectedVersion; on plan_version_conflict " +
        "read the plan again and retry. With review trust a plan starts as draft (see warnings) until a " +
        "human approves it; its tasks are then created pending. Ad-hoc tasks stay draft until a human queues them.",
    },
  );

  // Tools are served here (not through registerTool) so that input validation, error codes and
  // project injection come from the operations registry instead of the SDK.
  server.server.registerCapabilities({ tools: { listChanged: false } });

  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const principal = await resolve();
    return {
      tools: ops
        .filter((op) => op.scopes.length === 0 || op.scopes.some((s) => authorize(principal, s)))
        .map((op) => toolDefinition(op, options.project)),
    };
  });

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const op = byTool.get(request.params.name);
    if (!op) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    const args = request.params.arguments ?? {};
    const raw =
      options.project !== undefined && op.projectScoped
        ? { ...args, projectId: options.project }
        : args;
    const projectId =
      typeof (raw as { projectId?: unknown }).projectId === "string"
        ? (raw as { projectId: string }).projectId
        : undefined;
    const principal = await resolve();
    try {
      const result = await run(op, raw, extra.signal);
      options.onCall?.({ tool: op.mcp.name!, principal, projectId, ok: true });
      return successResult(op, result);
    } catch (err) {
      const opErr = toOpError(err);
      options.onCall?.({
        tool: op.mcp.name!,
        principal,
        projectId,
        ok: false,
        code: opErr.code,
      });
      return errorResult(opErr);
    }
  });

  registerResources(server, runtime);
  registerPrompts(server, runtime);
  // The SDK advertises listChanged: true for resources and prompts; the HTTP server is stateless
  // and never notifies (stdio does not either). Capabilities merge per key, so this wins.
  server.server.registerCapabilities({
    resources: { listChanged: false },
    prompts: { listChanged: false },
  });
  return server;
}

export { McpError, ErrorCode };
