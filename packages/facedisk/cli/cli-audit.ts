import {
  EpicError,
  HierarchyError,
  InvalidIdError,
  PlanExistsError,
  PlanNotActiveError,
  PlanNotFoundError,
  PlanValidationError,
  PlanVersionConflict,
  ProjectError,
  ProjectResolutionError,
  TaskNotFoundError,
  auditOperation,
  LOCAL_PRINCIPAL,
} from "@boof/heart";
import { ZodError } from "zod";

/** Local administrator, the only principal a hand-written command runs as. */
const CLI_PRINCIPAL = { id: LOCAL_PRINCIPAL.id, kind: LOCAL_PRINCIPAL.kind };

/**
 * Stable error code for an audit line. Messages, ids and Zod issues are left out: they repeat
 * the command's arguments.
 */
export function cliAuditCode(e: unknown): string {
  if (e instanceof ProjectError || e instanceof EpicError || e instanceof HierarchyError)
    return e.code;
  if (e instanceof ZodError) return "invalid_input";
  if (e instanceof InvalidIdError) return "invalid_id";
  if (e instanceof TaskNotFoundError || e instanceof PlanNotFoundError) return "not_found";
  if (e instanceof PlanNotActiveError) return "plan_not_active";
  if (e instanceof PlanVersionConflict) return "version_conflict";
  if (e instanceof PlanExistsError) return "plan_exists";
  if (e instanceof PlanValidationError) return "invalid_plan";
  if (e instanceof ProjectResolutionError) return "project_resolution";
  return "error";
}

export interface CliAudit {
  /** Record success. `project` overrides the one given to {@link beginCliAudit}. */
  ok(project?: string): Promise<void>;
  /** Record a failure. The line stores {@link cliAuditCode}, never the message. */
  fail(e: unknown, project?: string): Promise<void>;
  /** Record a failure whose code is already a stable token (no message, no argument). */
  failCode(code: string, project?: string): Promise<void>;
}

/**
 * Start a timer for one hand-written CLI write. Call `ok`, `fail` or `failCode` once when the
 * write finishes. The line is `auditOperation` with `via: "cli"` and action `cli:<command>`
 * (`cli:project.add`): principal, action, project, outcome, timing. Usage checks that return
 * before this stay unaudited, same as the generated CLI.
 */
export function beginCliAudit(root: string, action: string, project?: string): CliAudit {
  const at = Date.now();
  const write = (ok: boolean, code: string | undefined, projectOverride?: string) => {
    const chosen = projectOverride ?? project;
    return auditOperation(root, {
      principal: CLI_PRINCIPAL,
      action,
      via: "cli",
      ...(chosen ? { project: chosen } : {}),
      ok,
      ...(ok || !code ? {} : { code }),
      ms: Date.now() - at,
      at,
    });
  };
  return {
    ok: (projectOverride) => write(true, undefined, projectOverride),
    fail: (e, projectOverride) => write(false, cliAuditCode(e), projectOverride),
    failCode: (code, projectOverride) => write(false, code, projectOverride),
  };
}
