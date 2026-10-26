import { z } from "zod";
import type { Task } from "@boof-runner/shared";
import type { McpAnnotations, OpContext } from "../define-op.js";
import { toTaskView, type ProjectService, type TaskView } from "../services/service.js";

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A path parameter that becomes a filesystem name: kebab-case, so `../` never gets through. */
const idParam = (what: string, description: string) =>
  z.string().max(200).regex(KEBAB, `Invalid ${what}`).meta({ description });

export const projectIdParam = idParam("project id", "Project id (kebab-case).");
export const taskIdParam = idParam("id", "Task id (kebab-case).");
export const planIdParam = idParam("plan id", "Plan id (kebab-case).");
export const goalIdParam = idParam("goal id", "Goal id (kebab-case).");
export const clientIdParam = idParam("id", "API client id.");
export const commandIdParam = idParam("id", "Command template id.");
export const webhookIdParam = idParam("id", "Webhook id.");

export const READ: McpAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};
export const WRITE: McpAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
};
export const IDEMPOTENT_WRITE: McpAnnotations = { ...WRITE, idempotentHint: true };
export const DESTRUCTIVE: McpAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
};

export const requireProject = (ctx: OpContext, projectId: string): Promise<ProjectService> =>
  ctx.services.requireProject(projectId);

/** A task for the API: without its (huge) log unless `withLog` or on the unversioned routes. */
export const taskView = (
  ctx: OpContext,
  projectId: string,
  task: Task,
  withLog = false,
): TaskView => toTaskView(projectId, task, { log: ctx.legacy === true || withLog });

/** Weak ETag of a task: its `updated` stamp. */
export const taskEtag = (out: { frontmatter: { updated: string } }): string =>
  `W/"${out.frontmatter.updated}"`;

/** ETag of a plan result: its version. */
export const planEtag = (out: {
  version?: number;
  plan?: { version: number };
}): string | undefined => {
  const v = out.version ?? out.plan?.version;
  return typeof v === "number" ? `"${v}"` : undefined;
};
