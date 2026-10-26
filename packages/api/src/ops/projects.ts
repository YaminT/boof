import { z } from "zod";
import { authorizeProject, ProjectPatchSchema, type Project } from "@boof-runner/shared";
import { currentBranch } from "@boof-runner/runner";
import { defineOp } from "../define-op.js";
import { CreateProjectBody } from "../validation.js";
import { OkSchema, ProjectSchema, ProjectViewSchema, TokenUsageSchema } from "../schemas.js";
import { DESTRUCTIVE, IDEMPOTENT_WRITE, projectIdParam, READ, WRITE } from "./common.js";

/** The stored project plus the branch checked out in its working directory (best effort). */
const withBranch = async (p: Project) => ({
  ...p,
  currentBranch: p.workingDirectory ? await currentBranch(p.workingDirectory) : null,
});

const byProject = z.strictObject({ projectId: projectIdParam });

export const projectsList = defineOp({
  name: "projects.list",
  title: "List projects",
  description:
    "Lists the registered projects the client may access. Optional includeArchived adds archived ones. No side effects.",
  scope: "projects:read",
  projectScoped: false,
  input: z.strictObject({ includeArchived: z.boolean().optional() }),
  output: z.object({ projects: z.array(ProjectViewSchema) }),
  rest: { method: "GET", path: "/projects" },
  mcp: { expose: true, name: "boof_list_projects", annotations: READ },
  summary: (r) => `${r.projects.length} project(s): ${r.projects.map((p) => p.id).join(", ")}`,
  handler: async (ctx, input) => ({
    projects: await Promise.all(
      (await ctx.services.listProjects({ includeArchived: input.includeArchived === true }))
        .filter((p) => authorizeProject(ctx.principal, p.id))
        .map(withBranch),
    ),
  }),
});

export const projectsCreate = defineOp({
  name: "projects.create",
  title: "Create a project",
  description:
    "Registers a git work tree as a project. Inputs: workingDirectory (required, under an allowed root for API clients) and optional id, name and overrides. Creates the project's data directory.",
  scope: "projects:write",
  projectScoped: false,
  input: CreateProjectBody,
  output: ProjectSchema,
  rest: { method: "POST", path: "/projects", status: 201, idempotent: true },
  mcp: { expose: true, name: "boof_create_project", annotations: WRITE },
  summary: (p) => `Created project ${p.id} for ${p.workingDirectory}`,
  handler: (ctx, input) => ctx.services.createProject(input, ctx.principal),
});

export const projectsGet = defineOp({
  name: "projects.get",
  title: "Get a project",
  description:
    "Returns one project by id, with currentBranch (the branch checked out in its working directory, null when detached). Input: projectId. No side effects.",
  scope: "projects:read",
  projectScoped: true,
  input: byProject,
  output: ProjectViewSchema,
  rest: { method: "GET", path: "/projects/{projectId}" },
  mcp: { expose: true, name: "boof_get_project", annotations: READ },
  summary: (p) => `Project ${p.id}: ${p.name}${p.paused ? " (paused)" : ""}`,
  handler: async (ctx, input) => withBranch(await ctx.services.getProject(input.projectId)),
});

export const projectsUpdate = defineOp({
  name: "projects.update",
  title: "Update a project",
  description:
    "Changes project fields (name, workingDirectory, paused, labels, per-project overrides; null clears an override). Inputs: projectId plus the fields to change. Rewrites project.json.",
  scope: "projects:write",
  projectScoped: true,
  input: z.strictObject({ projectId: projectIdParam, ...ProjectPatchSchema.shape }),
  output: ProjectSchema,
  rest: { method: "PUT", path: "/projects/{projectId}" },
  mcp: { expose: true, name: "boof_update_project", annotations: IDEMPOTENT_WRITE },
  summary: (p) => `Updated project ${p.id}`,
  handler: (ctx, { projectId, ...patch }) =>
    ctx.services.updateProject(projectId, patch, ctx.principal),
});

export const projectsArchive = defineOp({
  name: "projects.archive",
  title: "Archive a project",
  description:
    "Archives a project: it disappears from listings and the runner skips it. Input: projectId. Sets archived on project.json; the data is kept.",
  scope: "projects:write",
  projectScoped: true,
  input: byProject,
  output: ProjectSchema,
  rest: { method: "POST", path: "/projects/{projectId}/archive" },
  mcp: { expose: false, name: "boof_archive_project", annotations: IDEMPOTENT_WRITE },
  summary: (p) => `Archived project ${p.id}`,
  handler: (ctx, input) => ctx.services.archiveProject(input.projectId),
});

export const projectsUnarchive = defineOp({
  name: "projects.unarchive",
  title: "Unarchive a project",
  description: "Restores an archived project. Input: projectId. Clears archived on project.json.",
  scope: "projects:write",
  projectScoped: true,
  input: byProject,
  output: ProjectSchema,
  rest: { method: "POST", path: "/projects/{projectId}/unarchive" },
  mcp: { expose: false, name: "boof_unarchive_project", annotations: IDEMPOTENT_WRITE },
  summary: (p) => `Unarchived project ${p.id}`,
  handler: (ctx, input) => ctx.services.unarchiveProject(input.projectId),
});

export const projectsPause = defineOp({
  name: "projects.pause",
  title: "Pause a project",
  description:
    "Stops the runner from starting tasks of a project; a running task finishes. Input: projectId. Sets paused on project.json.",
  scope: ["runner:control", "projects:write"],
  projectScoped: true,
  input: byProject,
  output: ProjectSchema,
  rest: { method: "POST", path: "/projects/{projectId}/pause" },
  mcp: { expose: false, name: "boof_pause_project", annotations: IDEMPOTENT_WRITE },
  summary: (p) => `Paused project ${p.id}`,
  handler: (ctx, input) => ctx.services.pauseProject(input.projectId),
});

export const projectsResume = defineOp({
  name: "projects.resume",
  title: "Resume a project",
  description:
    "Lets the runner pick up tasks of a paused project again. Input: projectId. Clears paused.",
  scope: ["runner:control", "projects:write"],
  projectScoped: true,
  input: byProject,
  output: ProjectSchema,
  rest: { method: "POST", path: "/projects/{projectId}/resume" },
  mcp: { expose: false, name: "boof_resume_project", annotations: IDEMPOTENT_WRITE },
  summary: (p) => `Resumed project ${p.id}`,
  handler: (ctx, input) => ctx.services.resumeProject(input.projectId),
});

export const projectsDelete = defineOp({
  name: "projects.delete",
  title: "Delete a project",
  description:
    "Archives a project, or with purge removes its data directory for good. Inputs: projectId, purge. Refused while a task of the project runs; the repository itself is never touched.",
  scope: "projects:write",
  projectScoped: true,
  input: z.strictObject({ projectId: projectIdParam, purge: z.boolean().optional() }),
  output: OkSchema,
  rest: { method: "DELETE", path: "/projects/{projectId}" },
  mcp: { expose: false, name: "boof_delete_project", annotations: DESTRUCTIVE },
  handler: (ctx, input) =>
    ctx.services.removeProject(input.projectId, { purge: input.purge === true }),
});

export const projectsUsage = defineOp({
  name: "projects.usage",
  title: "Project token usage",
  description:
    "Returns the token usage and cost of one project. Input: projectId. No side effects.",
  scope: ["projects:read", "tasks:read"],
  projectScoped: true,
  input: byProject,
  output: TokenUsageSchema,
  rest: { method: "GET", path: "/projects/{projectId}/usage" },
  mcp: { expose: false, name: "boof_get_project_usage", annotations: READ },
  summary: (u) => `${u.inputTokens} in / ${u.outputTokens} out tokens, $${u.costUsd.toFixed(2)}`,
  handler: (ctx, input) => ctx.services.projectUsage(input.projectId),
});

export const projectOps = [
  projectsList,
  projectsCreate,
  projectsGet,
  projectsUpdate,
  projectsArchive,
  projectsUnarchive,
  projectsPause,
  projectsResume,
  projectsDelete,
  projectsUsage,
];
