import { z } from "zod";
import { EpicPatchSchema } from "@boof-runner/shared";
import { defineOp } from "../define-op.js";
import { DeleteResultSchema, EpicViewSchema } from "../schemas.js";
import {
  DESTRUCTIVE,
  epicIdParam,
  IDEMPOTENT_WRITE,
  projectIdParam,
  READ,
  requireProject,
  WRITE,
} from "./common.js";

const epicEtag = (e: { updated: string }) => `W/"${e.updated}"`;
const epicResult = (e: z.output<typeof EpicViewSchema>) =>
  `Epic ${e.id}: ${e.progress.done}/${e.progress.total} done`;
const kebabId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

export const epicsList = defineOp({
  name: "epics.list",
  title: "List epics",
  description:
    "Lists a project's epics (priority descending, then oldest update) with their progress: non-archived top-level tasks and how many are done. Inputs: projectId, optional includeArchived. No side effects.",
  scope: "tasks:read",
  projectScoped: true,
  input: z.strictObject({
    projectId: projectIdParam,
    includeArchived: z.boolean().optional().meta({ description: "Also list archived epics." }),
  }),
  output: z.object({ items: z.array(EpicViewSchema) }),
  rest: { method: "GET", path: "/projects/{projectId}/epics" },
  mcp: { expose: true, name: "boof_list_epics", annotations: READ },
  summary: (r) => `${r.items.length} epic(s): ${r.items.map((e) => e.id).join(", ")}`,
  handler: async (ctx, input) => {
    const svc = await requireProject(ctx, input.projectId);
    return { items: await svc.listEpics({ includeArchived: input.includeArchived }) };
  },
});

export const epicsGet = defineOp({
  name: "epics.get",
  title: "Get an epic",
  description: "Returns one epic with its progress. Inputs: projectId, epicId. No side effects.",
  scope: "tasks:read",
  projectScoped: true,
  input: z.strictObject({ projectId: projectIdParam, epicId: epicIdParam }),
  output: EpicViewSchema,
  rest: { method: "GET", path: "/projects/{projectId}/epics/{epicId}", etag: epicEtag },
  mcp: { expose: true, name: "boof_get_epic", annotations: READ },
  summary: epicResult,
  handler: async (ctx, input) => (await requireProject(ctx, input.projectId)).getEpic(input.epicId),
});

export const epicsCreate = defineOp({
  name: "epics.create",
  title: "Create an epic",
  description:
    "Creates an epic, a named group of tasks in one project. Inputs: projectId, title, optional id (kebab; derived from the title; none is reserved), description, priority. Writes the project's epics.json.",
  scope: "tasks:write",
  projectScoped: true,
  input: z.strictObject({
    projectId: projectIdParam,
    title: z.string().trim().min(1).max(200),
    id: kebabId
      .max(200)
      .optional()
      .meta({ description: "Epic id (kebab-case); default derived from the title." }),
    description: z.string().max(20_000).optional(),
    priority: z.number().int().optional(),
  }),
  output: EpicViewSchema,
  rest: {
    method: "POST",
    path: "/projects/{projectId}/epics",
    status: 201,
    idempotent: true,
    etag: epicEtag,
  },
  mcp: { expose: true, name: "boof_create_epic", annotations: WRITE },
  summary: epicResult,
  handler: async (ctx, { projectId, ...input }) =>
    (await requireProject(ctx, projectId)).createEpic(input, ctx.principal),
});

export const epicsUpdate = defineOp({
  name: "epics.update",
  title: "Update an epic",
  description:
    "Edits an epic. Inputs: projectId, epicId, fields to change (title, description or null, priority, archived) and expectedUpdated (HTTP If-Match) to refuse a stale edit. Archiving hides the epic from the default list; its tasks keep it. Rewrites epics.json.",
  scope: "tasks:write",
  projectScoped: true,
  input: z.strictObject({
    projectId: projectIdParam,
    epicId: epicIdParam,
    ...EpicPatchSchema.shape,
    expectedUpdated: z.string().max(100).optional().meta({
      description: "The epic's `updated` stamp you last saw (HTTP: If-Match with the ETag).",
    }),
  }),
  output: EpicViewSchema,
  rest: {
    method: "PUT",
    path: "/projects/{projectId}/epics/{epicId}",
    ifMatch: "expectedUpdated",
    etag: epicEtag,
  },
  mcp: { expose: true, name: "boof_update_epic", annotations: IDEMPOTENT_WRITE },
  summary: epicResult,
  handler: async (ctx, { projectId, epicId, ...patch }) =>
    (await requireProject(ctx, projectId)).updateEpic(epicId, patch, ctx.principal),
});

export const epicsDelete = defineOp({
  name: "epics.delete",
  title: "Delete an epic",
  description:
    "Deletes an epic. An epic that tasks name is refused (409 has_tasks) unless detach=true, which clears their epic; archive it instead to keep the grouping. Inputs: projectId, epicId, optional detach (?detach=true). Review-trust clients may not delete epics. Rewrites epics.json and task files.",
  scope: "tasks:write",
  projectScoped: true,
  input: z.strictObject({
    projectId: projectIdParam,
    epicId: epicIdParam,
    detach: z.boolean().optional().meta({
      description: "Clear the epic on its tasks instead of refusing (409 has_tasks).",
    }),
  }),
  output: DeleteResultSchema,
  rest: { method: "DELETE", path: "/projects/{projectId}/epics/{epicId}" },
  mcp: { expose: false, name: "boof_delete_epic", annotations: DESTRUCTIVE },
  summary: (r) =>
    `Epic deleted${r.detached.length > 0 ? `; ${r.detached.length} task(s) detached` : ""}`,
  handler: async (ctx, { projectId, epicId, detach }) =>
    (await requireProject(ctx, projectId)).deleteEpic(epicId, { detach }, ctx.principal),
});

export const epicOps = [epicsList, epicsGet, epicsCreate, epicsUpdate, epicsDelete];
