import { z } from "zod";
import {
  authorize,
  authorizeProject,
  type AuthStore,
  type Principal,
  type Scope,
} from "@boof-runner/shared";
import { formatIssues, OpError, toOpError, type ErrorCode } from "./errors.js";
import type { TaskService } from "./services/service.js";

/** What an operation handler gets besides its validated input. */
export interface OpContext {
  /** The data root. */
  root: string;
  principal: Principal;
  services: TaskService;
  /** The client registry (same instance the HTTP authenticator uses, so revocations apply at once). */
  authStore: AuthStore;
  now: () => string;
  /**
   * True on the deprecated unversioned REST routes. Handlers behave as in v1 except where they
   * must keep the old shape (full task lists, `body.log` included). MCP and v1 leave it unset.
   */
  legacy?: boolean;
  /** True when a URL points at this very server (webhooks must not call back into boof). */
  isSelfUrl?: (url: URL) => boolean;
  /** Receives the operation's audit extras once the input is valid (REST puts them in the audit line). */
  audit?: (extra: Record<string, unknown>) => void;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RestSpec {
  method: HttpMethod;
  /** Relative to `/api/v1`; `{name}` segments are input fields. */
  path: string;
  /** Success status on `/api/v1` (default 200; the unversioned routes always answer 200). */
  status?: number;
  /** `If-Match` becomes this input field: the plan `version` or the task `updated` stamp. */
  ifMatch?: "expectedVersion" | "expectedUpdated";
  /** Value of the `ETag` response header for a result. */
  etag?: (output: never) => string | undefined;
  /** Honour the `Idempotency-Key` header (24 h replay). */
  idempotent?: boolean;
  /** multipart/form-data request (`file` field) or a binary response; everything else is JSON. */
  kind?: "json" | "multipart" | "binary";
  /** Reshape the result for the unversioned routes. */
  legacyOutput?: (output: never) => unknown;
}

export interface McpAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export interface McpSpec {
  expose: boolean;
  /** Stable tool name, `^[a-zA-Z0-9_-]{1,64}$`, `boof_<verb>_<noun>`. Required when exposed. */
  name?: string;
  annotations?: McpAnnotations;
}

export const MCP_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export interface OperationSpec<I extends z.ZodObject, O extends z.ZodType> {
  /** REST id, `area.verb`: `projects.create`. */
  name: string;
  title: string;
  /** One sentence what, one sentence inputs, one sentence side effects. */
  description: string;
  /** The scope needed; an array means any one of them suffices; an empty array: any authenticated caller. */
  scope: Scope | Scope[];
  /** The input has a `projectId` the principal must be allowed to touch. */
  projectScoped: boolean;
  /** Always a strict object so unknown keys are rejected. */
  input: I;
  output: O;
  rest: RestSpec;
  mcp: McpSpec;
  /** Error code for input that fails validation (`invalid_plan` for plan bodies). */
  invalidInputCode?: ErrorCode;
  /** Extra fields for the audit line (never bodies or secrets). */
  audit?: (input: z.output<I>) => Record<string, unknown>;
  /** Text for MCP `content` (the structured result is sent next to it). */
  summary?: (result: z.output<O>) => string;
  handler: (ctx: OpContext, input: z.output<I>) => Promise<z.input<O>>;
}

export interface Operation<
  I extends z.ZodObject = z.ZodObject,
  O extends z.ZodType = z.ZodType,
> extends OperationSpec<I, O> {
  /** The scopes as a list. */
  scopes: Scope[];
  /** `{name}` placeholders of `rest.path`, in order. */
  pathParams: string[];
  /** Check scope, validate `raw`, authorize the project, run, validate and return the output. */
  execute(ctx: OpContext, raw: unknown): Promise<z.output<O>>;
  /** Scope check alone (throws 403 `forbidden_scope`). */
  assertScope(principal: Principal): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyOperation = Operation<any, any>;

/**
 * Define one operation: schemas, scope and handler in one place. REST routes and MCP tools are
 * generated from it. `execute` is the only way in: it checks the scope, validates the input,
 * authorizes the project, runs the handler, validates the output (a handler can never return
 * something the schema does not describe) and maps every failure to an {@link OpError}.
 */
export function defineOp<I extends z.ZodObject, O extends z.ZodType>(
  spec: OperationSpec<I, O>,
): Operation<I, O> {
  if (spec.mcp.expose && !(spec.mcp.name && MCP_NAME.test(spec.mcp.name))) {
    throw new Error(`${spec.name}: an exposed operation needs a valid mcp.name`);
  }
  const scopes = Array.isArray(spec.scope) ? spec.scope : [spec.scope];
  const pathParams = [...spec.rest.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

  const assertScope = (principal: Principal): void => {
    if (scopes.length === 0 || scopes.some((s) => authorize(principal, s))) return;
    throw new OpError(
      403,
      `Missing required scope: ${scopes.join(" or ")}`,
      "forbidden_scope",
      scopes.length > 1 ? { scope: scopes[0], anyOf: scopes } : { scope: scopes[0] },
    );
  };

  const execute = async (ctx: OpContext, raw: unknown): Promise<z.output<O>> => {
    try {
      assertScope(ctx.principal);
      const parsed = spec.input.safeParse(raw);
      if (!parsed.success) {
        const issues = formatIssues(parsed.error);
        const onlyIds = issues.every((i) => pathParams.includes(i.path.split(".")[0]));
        throw new OpError(
          400,
          "Invalid input",
          onlyIds ? "invalid_input" : (spec.invalidInputCode ?? "invalid_input"),
          issues,
        );
      }
      const input = parsed.data as z.output<I>;
      if (spec.audit) ctx.audit?.(spec.audit(input));
      if (spec.projectScoped) {
        const projectId = (input as { projectId: string }).projectId;
        if (!authorizeProject(ctx.principal, projectId)) {
          throw new OpError(
            403,
            `This client may not access project: ${projectId}`,
            "forbidden_project",
            { project: projectId },
          );
        }
      }
      const result = await spec.handler(ctx, input);
      const out = spec.output.safeParse(result);
      if (!out.success) {
        console.error(`${spec.name}: handler result violates its output schema`, out.error.issues);
        throw new OpError(500, "Internal error", "internal");
      }
      return out.data;
    } catch (err) {
      throw toOpError(err);
    }
  };

  return { ...spec, scopes, pathParams, execute, assertScope };
}
