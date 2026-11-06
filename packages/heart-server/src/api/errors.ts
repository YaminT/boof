import { ZodError } from "zod";
import {
  InvalidIdError,
  InvalidTransitionError,
  EpicError,
  HierarchyError,
  TaskExistsError,
  TaskNotFoundError,
  TaskNotRunningError,
  TaskRunningError,
} from "@boof/heart";

/**
 * Every error code an operation can return, with the HTTP status REST uses for it. MCP reports
 * the same code in an `isError` result. The table is the single list the docs and the OpenAPI
 * document are generated from; a code that is not here does not exist.
 */
export const ERROR_CODES = {
  invalid_input: [400, "The input does not match the operation's schema, or an id is malformed."],
  invalid_plan: [
    400,
    "A plan or goal in the input is invalid (schema, dangling dependency, cycle).",
  ],
  not_a_git_repo: [400, "The project directory is not a git work tree."],
  nothing_to_import: [400, "The repository has no goal.boof.xml files to import."],
  no_default_project: [
    404,
    "The unversioned task routes need settings.defaultProject, which is unset.",
  ],
  unauthenticated: [401, "No credentials, or an invalid, expired or revoked API key."],
  forbidden_scope: [403, "The client lacks the scope the operation needs."],
  forbidden_project: [403, "The client may not access this project."],
  forbidden_trust: [403, "The client has review trust: a human must approve this change."],
  project_root_not_allowed: [403, "The directory is outside security.allowedProjectRoots."],
  origin_not_allowed: [
    403,
    "The Origin header names a site that is not this server: a cross-site browser request.",
  ],
  not_found: [404, "The task, command, client or webhook does not exist."],
  project_not_found: [404, "The project does not exist."],
  branch_not_found: [
    404,
    "The task branch boof-runner/<id> does not exist (never ran in a worktree, or deleted by onDone=delete).",
  ],
  epic_not_found: [404, "The epic does not exist in this project."],
  parent_not_found: [404, "The parent task does not exist in this project."],
  plan_not_found: [404, "The plan does not exist."],
  goal_not_found: [404, "The goal does not exist in the plan."],
  conflict: [409, "The change conflicts with the current state."],
  invalid_transition: [409, "The task status transition is not allowed."],
  invalid_hierarchy: [
    409,
    "The move or create breaks the hierarchy rules (one level of subtasks; a subtask has no epic of its own).",
  ],
  has_children: [409, "The task has subtasks; pass detach to make them top-level tasks."],
  has_tasks: [
    409,
    "The epic has tasks; pass detach to clear their epic, or archive the epic instead.",
  ],
  epic_modified: [409, "The epic changed since the ETag in If-Match."],
  plan_version_conflict: [409, "The plan changed since the version in If-Match / expectedVersion."],
  settings_modified: [409, "The settings changed since the ETag in If-Match."],
  task_modified: [409, "The task changed since the ETag in If-Match."],
  plan_exists: [409, "A plan with this id already exists."],
  plan_not_active: [409, "The plan is not active; activate it before syncing."],
  goal_has_dependents: [409, "Other goals depend on this one; pass cascade to remove them too."],
  project_exists: [409, "A project for this directory already exists."],
  project_busy: [
    409,
    "A task of the project is running, or another project is being created right now; retry shortly.",
  ],
  directory_not_empty: [
    409,
    "The directory exists and is not empty; send path.confirm: true to initialise it anyway.",
  ],
  idempotency_conflict: [409, "The Idempotency-Key was already used with a different request."],
  host_not_allowed: [421, "The Host header is not a loopback name or an allowed host."],
  payload_too_large: [413, "The request body exceeds the size limit."],
  unsupported_media_type: [415, "A JSON operation needs Content-Type: application/json."],
  concierge_unavailable: [409, "The assistant cannot run here; the message says why."],
  concierge_busy: [409, "A message to the assistant is still being answered."],
  concierge_limit: [409, "The conversation reached its cost limit; start a new one."],
  budget_exceeded: [409, "A daily budget that covers the assistant is used up."],
  change_not_found: [404, "The pending change does not exist or is no longer available."],
  change_stale: [409, "The target changed since the assistant proposed this change."],
  change_expired: [409, "The pending change expired."],
  rate_limited: [429, "Too many requests; retry after the Retry-After header."],
  not_configured: [409, "No account pool is configured (settings.owlish is not set)."],
  gateway_error: [502, "The account pool gateway (better-ccflare) failed or is unreachable."],
  internal: [500, "Unexpected server error; details are in the server log."],
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

function defaultCodeFor(status: number): ErrorCode {
  if (status === 400) return "invalid_input";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  return "internal";
}

/** The error every operation throws: a stable code, an HTTP status and a readable message. */
export class OpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: ErrorCode = defaultCodeFor(status),
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "OpError";
  }

  /** The public body: `{ error: { code, message, details? } }`. */
  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function formatIssues(err: ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** Map any thrown value to an {@link OpError}. Never leaks internals (unknown errors are `internal`). */
export function toOpError(err: unknown): OpError {
  if (err instanceof OpError) return err;
  if (err instanceof EpicError) {
    if (err.code === "not_found") return new OpError(404, err.message, "epic_not_found");
    if (err.code === "modified") return new OpError(409, err.message, "epic_modified");
    return new OpError(409, err.message, "conflict");
  }
  if (err instanceof HierarchyError) {
    const status = err.code === "epic_not_found" || err.code === "parent_not_found" ? 404 : 409;
    return new OpError(status, err.message, err.code);
  }
  if (err instanceof TaskNotFoundError) return new OpError(404, err.message, "not_found");
  if (err instanceof InvalidTransitionError) {
    return new OpError(409, err.message, "invalid_transition");
  }
  if (err instanceof TaskRunningError) {
    return new OpError(400, "Cannot delete a running task; wait for it to finish first");
  }
  if (err instanceof TaskNotRunningError) return new OpError(400, "Task is not running");
  if (err instanceof TaskExistsError) return new OpError(409, err.message, "conflict");
  if (err instanceof InvalidIdError) return new OpError(400, err.message, "invalid_input");
  if (err instanceof ZodError) {
    return new OpError(400, "Invalid input", "invalid_input", formatIssues(err));
  }
  console.error(err);
  return new OpError(500, "Internal error", "internal");
}
