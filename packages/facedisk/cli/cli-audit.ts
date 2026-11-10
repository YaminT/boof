import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  SettingsSchema,
  TaskNotFoundError,
  auditOperation,
  dataRootPaths,
  isKebabId,
  LOCAL_PRINCIPAL,
  securitySettings,
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
 * Last filter on a project id. Callers pass only an id that resolved to an existing project, or a
 * new id `project add` accepted. This still drops a pasted key that is not kebab-case.
 */
function storedProject(id: string | undefined): string | undefined {
  return isKebabId(id) ? id : undefined;
}

function auditEnabled(root: string): boolean {
  const settingsPath = dataRootPaths(root).settings;
  if (!existsSync(settingsPath)) return true;
  const raw: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  return securitySettings(SettingsSchema.parse(raw)).audit.enabled;
}

/**
 * Start a timer for one hand-written CLI write. Call `ok`, `fail` or `failCode` once when the
 * write finishes. The line is `auditOperation` with `via: "cli"` and action `cli:<command>`
 * (`cli:project.add`): principal, action, project, outcome, timing. Usage checks that return
 * before this stay unaudited, same as the generated CLI.
 *
 * The project field is an id the command resolved, or a new id it accepted. A missing data root
 * writes nothing and is not created: a refusal must not leave `./data` behind. Commands that
 * scaffold a root do that themselves before they record success.
 */
export function beginCliAudit(root: string, action: string, project?: string): CliAudit {
  const at = Date.now();
  const write = (ok: boolean, code: string | undefined, projectOverride?: string) => {
    if (!existsSync(root)) return Promise.resolve();
    const chosen =
      projectOverride !== undefined ? storedProject(projectOverride) : storedProject(project);
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

/**
 * Audit a write that failed while resolving `--project`. An unknown or invalid project is an
 * error inside the command, so it writes one line, as the generated CLI does. A missing flag
 * (`projectOpt` undefined) is a usage error and writes none. The raw value is not a project:
 * it did not resolve, so the line has no `project` field.
 */
export async function auditProjectRefusal(
  root: string,
  action: string,
  projectOpt: string | undefined,
  e: unknown,
): Promise<void> {
  if (projectOpt === undefined) return;
  const audit = beginCliAudit(root, action);
  if (e instanceof InvalidIdError || e instanceof ProjectResolutionError) await audit.fail(e);
  else await audit.failCode("project_resolution");
}

/**
 * One `interrupted` line, written from a SIGINT handler. Synchronous, so it finishes before the
 * process is killed. A missing root is left missing. A failed write is the caller's to report.
 */
export function writeInterruptedSync(
  root: string,
  action: string,
  at: number,
  project?: string,
): void {
  if (!existsSync(root) || !auditEnabled(root)) return;
  const chosen = storedProject(project);
  const line = {
    ts: new Date(at).toISOString(),
    principal: CLI_PRINCIPAL.id,
    kind: CLI_PRINCIPAL.kind,
    action,
    via: "cli" as const,
    ...(chosen ? { project: chosen } : {}),
    outcome: "error" as const,
    error: "interrupted",
    ms: Date.now() - at,
  };
  const dir = dataRootPaths(root).audit;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${line.ts.slice(0, 10)}.jsonl`), JSON.stringify(line) + "\n", "utf8");
}
