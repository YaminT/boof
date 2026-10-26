import { z } from "zod";
import { StatusSchema } from "@boof-runner/shared";
import { defineOp, type OpContext } from "../define-op.js";
import { OpError } from "../errors.js";
import { promptFingerprint } from "../audit.js";
import {
  AnswersBody,
  CreateTaskBody,
  InjectBody,
  ReorderBody,
  SkipBody,
  UpdateTaskBody,
} from "../validation.js";
import {
  InjectResultSchema,
  OkSchema,
  TaskCreateResultSchema,
  TaskDiffSchema,
  TaskViewSchema,
} from "../schemas.js";
import {
  DESTRUCTIVE,
  IDEMPOTENT_WRITE,
  planIdParam,
  projectIdParam,
  READ,
  requireProject,
  taskEtag,
  taskIdParam,
  taskView,
  WRITE,
} from "./common.js";

const byTask = z.strictObject({ projectId: projectIdParam, taskId: taskIdParam });
const taskResult = (t: z.output<typeof TaskViewSchema>) =>
  `Task ${t.frontmatter.id} is ${t.frontmatter.status}`;

export const DEFAULT_PAGE = 100;
export const MAX_PAGE = 500;

function encodeCursor(updated: string, id: string): string {
  return Buffer.from(JSON.stringify([updated, id])).toString("base64url");
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string") {
      return [v[0], v[1]];
    }
  } catch {
    /* fall through */
  }
  throw new OpError(400, "Invalid cursor", "invalid_input", [
    { path: "cursor", message: "Invalid cursor" },
  ]);
}

export const tasksList = defineOp({
  name: "tasks.list",
  title: "List tasks",
  description:
    "Lists a project's tasks, newest update first, without their logs. Inputs: projectId, optional status, plan, label filters and limit/cursor paging. No side effects.",
  scope: "tasks:read",
  projectScoped: true,
  input: z.strictObject({
    projectId: projectIdParam,
    status: StatusSchema.optional(),
    plan: planIdParam.optional(),
    label: z.string().max(100).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE)
      .optional()
      .meta({ description: `Page size, default ${DEFAULT_PAGE}, max ${MAX_PAGE}.` }),
    cursor: z
      .string()
      .max(500)
      .optional()
      .meta({ description: "nextCursor of the previous page." }),
  }),
  output: z.object({ items: z.array(TaskViewSchema), nextCursor: z.string().nullable() }),
  rest: {
    method: "GET",
    path: "/projects/{projectId}/tasks",
    legacyOutput: (out: { items: unknown[] }) => ({ tasks: out.items }),
  },
  mcp: { expose: true, name: "boof_list_tasks", annotations: READ },
  summary: (r) =>
    `${r.items.length} task(s)${r.nextCursor ? " (more available)" : ""}: ${r.items
      .map((t) => `${t.frontmatter.id}[${t.frontmatter.status}]`)
      .join(", ")}`,
  handler: async (ctx, input) => {
    const svc = await requireProject(ctx, input.projectId);
    let tasks = await svc.list();
    if (input.status) tasks = tasks.filter((t) => t.frontmatter.status === input.status);
    if (input.plan) tasks = tasks.filter((t) => t.frontmatter.planRef?.planId === input.plan);
    if (input.label) tasks = tasks.filter((t) => t.frontmatter.labels.includes(input.label!));
    if (ctx.legacy) {
      return { items: tasks.map((t) => taskView(ctx, svc.projectId, t)), nextCursor: null };
    }
    tasks.sort(
      (a, b) =>
        b.frontmatter.updated.localeCompare(a.frontmatter.updated) ||
        a.frontmatter.id.localeCompare(b.frontmatter.id),
    );
    if (input.cursor) {
      const [updated, id] = decodeCursor(input.cursor);
      tasks = tasks.filter(
        (t) =>
          t.frontmatter.updated < updated ||
          (t.frontmatter.updated === updated && t.frontmatter.id > id),
      );
    }
    const limit = input.limit ?? DEFAULT_PAGE;
    const page = tasks.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((t) => taskView(ctx, svc.projectId, t)),
      nextCursor:
        tasks.length > limit && last
          ? encodeCursor(last.frontmatter.updated, last.frontmatter.id)
          : null,
    };
  },
});

export const tasksGet = defineOp({
  name: "tasks.get",
  title: "Get a task",
  description:
    "Returns one task with its prompt, questions, answers and reports. Inputs: projectId, taskId, and include=log to add the raw agent log (large). No side effects.",
  scope: "tasks:read",
  projectScoped: true,
  input: z.strictObject({
    projectId: projectIdParam,
    taskId: taskIdParam,
    include: z
      .enum(["log"])
      .optional()
      .meta({ description: "log: add body.log (can be megabytes)." }),
  }),
  output: TaskViewSchema,
  rest: { method: "GET", path: "/projects/{projectId}/tasks/{taskId}", etag: taskEtag },
  mcp: { expose: true, name: "boof_get_task", annotations: READ },
  summary: taskResult,
  handler: async (ctx, input) => {
    const svc = await requireProject(ctx, input.projectId);
    const t = await svc.get(input.taskId);
    if (!t) throw new OpError(404, "Task not found");
    return taskView(ctx, svc.projectId, t, input.include === "log");
  },
});

export const tasksDiff = defineOp({
  name: "tasks.diff",
  title: "Get what a task changed",
  description:
    "Shows what a task's branch boof-runner/<id> changed against its base: commits, changed files with +/- counts and a unified diff. A running task or a kept worktree adds its uncommitted changes (includesUncommitted). Inputs: projectId, taskId, optional path (one repo-relative file, returns only its patch), context lines, maxBytes (default 400000; a bigger whole diff returns files without a patch and truncated=true). 404 branch_not_found when the branch is gone. Read-only.",
  scope: "tasks:read",
  projectScoped: true,
  input: z.strictObject({
    projectId: projectIdParam,
    taskId: taskIdParam,
    path: z.string().min(1).max(1000).optional().meta({
      description: "Repo-relative file path (no '..'); returns that file's patch only.",
    }),
    context: z.number().int().min(0).max(100).optional().meta({
      description: "Context lines around each change, default 3.",
    }),
    maxBytes: z.number().int().min(1000).max(5_000_000).optional().meta({
      description: "Largest patch to return, default 400000.",
    }),
  }),
  output: TaskDiffSchema,
  rest: { method: "GET", path: "/projects/{projectId}/tasks/{taskId}/diff" },
  mcp: { expose: true, name: "boof_get_task_diff", annotations: READ },
  summary: (d) =>
    `${d.head.ref}: ${d.stats.files} file(s), +${d.stats.additions} -${d.stats.deletions}, ${d.commits.length} commit(s)${d.truncated ? " (patch truncated)" : ""}`,
  handler: async (ctx, { projectId, taskId, ...opts }) => {
    const svc = await requireProject(ctx, projectId);
    return svc.taskDiff(taskId, opts);
  },
});

export const tasksCreate = defineOp({
  name: "tasks.create",
  title: "Create a task",
  description:
    "Creates a task in a project. Inputs: projectId, title, optional prompt, priority, labels, command, status (draft or pending), runs. Review-trust clients always get a draft and a warnings entry (status_downgraded, header Boof-Warning); a human queues it.",
  scope: "tasks:write",
  projectScoped: true,
  input: z.strictObject({ projectId: projectIdParam, ...CreateTaskBody.shape }),
  output: TaskCreateResultSchema,
  rest: {
    method: "POST",
    path: "/projects/{projectId}/tasks",
    status: 201,
    idempotent: true,
    etag: taskEtag,
  },
  mcp: { expose: true, name: "boof_create_task", annotations: WRITE },
  audit: (input) => promptFingerprint(input.prompt ?? ""),
  summary: taskResult,
  handler: async (ctx, { projectId, ...body }) => {
    const svc = await requireProject(ctx, projectId);
    const { task, warnings } = await svc.createWithWarnings(body, ctx.principal);
    return { ...taskView(ctx, projectId, task), ...(warnings.length > 0 ? { warnings } : {}) };
  },
});

export const tasksUpdate = defineOp({
  name: "tasks.update",
  title: "Update a task",
  description:
    "Edits task fields; a changed status is a transition. Inputs: projectId, taskId, fields to change, and expectedUpdated (HTTP If-Match) to refuse a stale edit. Rewrites the task file.",
  scope: "tasks:write",
  projectScoped: true,
  input: z.strictObject({
    projectId: projectIdParam,
    taskId: taskIdParam,
    ...UpdateTaskBody.shape,
    expectedUpdated: z.string().max(100).optional().meta({
      description: "The task's `updated` stamp you last saw (HTTP: If-Match with the ETag).",
    }),
  }),
  output: TaskViewSchema,
  rest: {
    method: "PUT",
    path: "/projects/{projectId}/tasks/{taskId}",
    ifMatch: "expectedUpdated",
    etag: taskEtag,
  },
  mcp: { expose: true, name: "boof_update_task", annotations: IDEMPOTENT_WRITE },
  summary: taskResult,
  handler: async (ctx, { projectId, taskId, ...patch }) => {
    const svc = await requireProject(ctx, projectId);
    return taskView(ctx, projectId, await svc.update(taskId, patch, ctx.principal));
  },
});

export const tasksQueue = defineOp({
  name: "tasks.queue",
  title: "Queue a task",
  description:
    "Moves a draft task to pending so the runner picks it up. Inputs: projectId, taskId. Review-trust clients are refused (403 forbidden_trust).",
  scope: "tasks:write",
  projectScoped: true,
  input: byTask,
  output: TaskViewSchema,
  rest: { method: "POST", path: "/projects/{projectId}/tasks/{taskId}/queue", etag: taskEtag },
  mcp: { expose: true, name: "boof_queue_task", annotations: IDEMPOTENT_WRITE },
  summary: taskResult,
  handler: async (ctx, input) => {
    const svc = await requireProject(ctx, input.projectId);
    return taskView(
      ctx,
      input.projectId,
      await svc.update(input.taskId, { status: "pending" }, ctx.principal),
    );
  },
});

export const tasksSkip = defineOp({
  name: "tasks.skip",
  title: "Skip or unskip a task",
  description:
    "Sets the skip flag of a task; the runner ignores skipped tasks. Inputs: projectId, taskId, skip.",
  scope: "tasks:write",
  projectScoped: true,
  input: z.strictObject({ projectId: projectIdParam, taskId: taskIdParam, ...SkipBody.shape }),
  output: TaskViewSchema,
  rest: { method: "POST", path: "/projects/{projectId}/tasks/{taskId}/skip" },
  mcp: { expose: false, name: "boof_skip_task", annotations: IDEMPOTENT_WRITE },
  summary: taskResult,
  handler: async (ctx, input) => {
    const svc = await requireProject(ctx, input.projectId);
    return taskView(ctx, input.projectId, await svc.setSkip(input.taskId, input.skip));
  },
});

export const tasksReorder = defineOp({
  name: "tasks.reorder",
  title: "Reorder tasks",
  description:
    "Sets the priority order of tasks. Inputs: projectId, order (task ids, first runs first). Rewrites the priority of each listed task.",
  scope: "tasks:write",
  projectScoped: true,
  input: z.strictObject({ projectId: projectIdParam, ...ReorderBody.shape }),
  output: z.object({ tasks: z.array(TaskViewSchema) }),
  rest: { method: "POST", path: "/projects/{projectId}/tasks/reorder" },
  mcp: { expose: false, name: "boof_reorder_tasks", annotations: IDEMPOTENT_WRITE },
  summary: (r) => `Reordered ${r.tasks.length} task(s)`,
  handler: async (ctx, input) => {
    const svc = await requireProject(ctx, input.projectId);
    return {
      tasks: (await svc.reorder(input.order)).map((t) => taskView(ctx, input.projectId, t)),
    };
  },
});

export const tasksRetry = defineOp({
  name: "tasks.retry",
  title: "Retry a task",
  description:
    "Moves a failed or stopped task back to pending (a stopped task continues in its kept worktree). Inputs: projectId, taskId. Review-trust clients are refused.",
  scope: "tasks:write",
  projectScoped: true,
  input: byTask,
  output: TaskViewSchema,
  rest: { method: "POST", path: "/projects/{projectId}/tasks/{taskId}/retry" },
  mcp: { expose: true, name: "boof_retry_task", annotations: WRITE },
  summary: taskResult,
  handler: async (ctx, input) => {
    const svc = await requireProject(ctx, input.projectId);
    return taskView(ctx, input.projectId, await svc.retry(input.taskId, ctx.principal));
  },
});

export const tasksArchive = defineOp({
  name: "tasks.archive",
  title: "Archive a task",
  description:
    "Archives a task that is not running. Inputs: projectId, taskId. Moves the task file to archived.",
  scope: "tasks:write",
  projectScoped: true,
  input: byTask,
  output: TaskViewSchema,
  rest: { method: "POST", path: "/projects/{projectId}/tasks/{taskId}/archive" },
  mcp: { expose: true, name: "boof_archive_task", annotations: IDEMPOTENT_WRITE },
  summary: taskResult,
  handler: async (ctx, input) => {
    const svc = await requireProject(ctx, input.projectId);
    return taskView(ctx, input.projectId, await svc.archive(input.taskId, ctx.principal));
  },
});

export const tasksUnarchive = defineOp({
  name: "tasks.unarchive",
  title: "Unarchive a task",
  description:
    "Moves an archived task back to pending. Inputs: projectId, taskId. Review-trust clients are refused.",
  scope: "tasks:write",
  projectScoped: true,
  input: byTask,
  output: TaskViewSchema,
  rest: { method: "POST", path: "/projects/{projectId}/tasks/{taskId}/unarchive" },
  mcp: { expose: false, name: "boof_unarchive_task", annotations: WRITE },
  summary: taskResult,
  handler: async (ctx, input) => {
    const svc = await requireProject(ctx, input.projectId);
    return taskView(ctx, input.projectId, await svc.unarchive(input.taskId, ctx.principal));
  },
});

export const tasksDelete = defineOp({
  name: "tasks.delete",
  title: "Delete a task",
  description:
    "Permanently deletes a task and its attachments; a running task must finish first. Inputs: projectId, taskId. Removes files.",
  scope: "tasks:write",
  projectScoped: true,
  input: byTask,
  output: OkSchema,
  rest: { method: "DELETE", path: "/projects/{projectId}/tasks/{taskId}" },
  mcp: { expose: false, name: "boof_delete_task", annotations: DESTRUCTIVE },
  summary: () => "Task deleted",
  handler: async (ctx, input) =>
    (await requireProject(ctx, input.projectId)).deleteTask(input.taskId),
});

export const tasksAnswers = defineOp({
  name: "tasks.answers",
  title: "Answer a task's questions",
  description:
    "Answers the planner's questions of a parked task and resumes it. Inputs: projectId, taskId, answers (text). Moves the task from action to pending.",
  scope: "tasks:write",
  projectScoped: true,
  input: z.strictObject({ projectId: projectIdParam, taskId: taskIdParam, ...AnswersBody.shape }),
  output: TaskViewSchema,
  rest: { method: "POST", path: "/projects/{projectId}/tasks/{taskId}/answers" },
  mcp: { expose: true, name: "boof_answer_task", annotations: WRITE },
  summary: taskResult,
  handler: async (ctx, input) => {
    const svc = await requireProject(ctx, input.projectId);
    return taskView(
      ctx,
      input.projectId,
      await svc.submitAnswers(input.taskId, input.answers, ctx.principal),
    );
  },
});

export const tasksStop = defineOp({
  name: "tasks.stop",
  title: "Stop a running task",
  description:
    "Asks the runner to stop a running task. Inputs: projectId, taskId. Writes a stop request the engine acts on; the task then moves to the stopped status with its worktree and branch kept, and tasks.retry continues it there.",
  scope: "tasks:control",
  projectScoped: true,
  input: byTask,
  output: OkSchema,
  rest: { method: "POST", path: "/projects/{projectId}/tasks/{taskId}/stop" },
  mcp: { expose: true, name: "boof_stop_task", annotations: DESTRUCTIVE },
  summary: () => "Stop requested",
  handler: async (ctx, input) =>
    (await requireProject(ctx, input.projectId)).stopTask(input.taskId),
});

export const tasksInject = defineOp({
  name: "tasks.inject",
  title: "Inject a prompt into a running task",
  description:
    "Adds an instruction to a running task. Inputs: projectId, taskId, prompt, optional mode: `next-step` (default) is picked up before the next pipeline step; `now` also interrupts the running step, which is resumed in the same tool session when the tool supports it or restarted with the prompt otherwise (costs extra tokens). The prompt is also kept, with a timestamp, the mode and who injected it, in the task's body.injected so it survives after the run. Returns applied: pending; the task log shows `### Steered` once a `now` prompt is applied.",
  scope: "tasks:control",
  projectScoped: true,
  input: z.strictObject({ projectId: projectIdParam, taskId: taskIdParam, ...InjectBody.shape }),
  output: InjectResultSchema,
  rest: { method: "POST", path: "/projects/{projectId}/tasks/{taskId}/inject" },
  mcp: { expose: true, name: "boof_inject_prompt", annotations: WRITE },
  summary: () => "Prompt injected",
  handler: async (ctx, input) =>
    (await requireProject(ctx, input.projectId)).injectPrompt(
      input.taskId,
      input.prompt,
      ctx.principal,
      input.mode,
    ),
});

export const tasksLiveLog = defineOp({
  name: "tasks.liveLog",
  title: "Read a task's live log",
  description:
    "Returns the streaming agent log of a running task, or the stored log after it finished. Inputs: projectId, taskId, optional format=text (REST: text/plain instead of JSON). No side effects.",
  scope: "tasks:read",
  projectScoped: true,
  input: z.strictObject({
    ...byTask.shape,
    format: z
      .enum(["json", "text"])
      .optional()
      .meta({ description: "text: the REST route answers text/plain with the log only." }),
  }),
  output: z.object({ log: z.string(), running: z.boolean() }),
  rest: {
    method: "GET",
    path: "/projects/{projectId}/tasks/{taskId}/live-log",
    text: (out: { log: string }) => out.log,
  },
  mcp: { expose: true, name: "boof_get_task_log", annotations: READ },
  summary: (r) => (r.running ? "Task is running; log attached" : "Task finished; log attached"),
  handler: async (ctx, input) => (await requireProject(ctx, input.projectId)).liveLog(input.taskId),
});

export const WAIT_MAX_SECONDS = 60;
const WAIT_POLL_MS = 400;

/** Statuses a task does not leave by itself: waiting on it would block for nothing. */
const SETTLED = new Set(["done", "failed", "stopped", "action", "archived"]);
/** Statuses that end a task for good (until a human retries or unarchives it). */
const TERMINAL = new Set(["done", "failed", "stopped", "archived"]);

export const tasksWait = defineOp({
  name: "tasks.wait",
  title: "Wait for a task status change",
  description: `Waits up to ${WAIT_MAX_SECONDS} seconds until a task leaves the status it is in (or the status given in since), or reaches the status given in until, then returns the task. A task that is already done, failed, stopped, action or archived, or already in the until status, returns at once with changed false. Inputs: projectId, taskId, optional since, until, timeoutSeconds. Output: changed, timedOut, terminal (true for done, failed, stopped, archived), task. No side effects; call it again after a timeout.`,
  scope: "tasks:read",
  projectScoped: true,
  input: z.strictObject({
    projectId: projectIdParam,
    taskId: taskIdParam,
    since: StatusSchema.optional().meta({
      description: "Return once the status differs from this one (default: the status now).",
    }),
    until: StatusSchema.optional().meta({
      description: "Also return once the status equals this.",
    }),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(WAIT_MAX_SECONDS)
      .optional()
      .meta({ description: `Longest wait in seconds, default 30, max ${WAIT_MAX_SECONDS}.` }),
  }),
  output: z.object({
    changed: z.boolean(),
    timedOut: z.boolean(),
    terminal: z.boolean().meta({
      description: "True when the task is done, failed, stopped or archived: stop waiting.",
    }),
    task: TaskViewSchema,
  }),
  rest: { method: "GET", path: "/projects/{projectId}/tasks/{taskId}/wait" },
  mcp: { expose: true, name: "boof_wait_task", annotations: READ },
  summary: (r) =>
    r.timedOut
      ? `Task ${r.task.frontmatter.id} is still ${r.task.frontmatter.status} (timed out)`
      : `Task ${r.task.frontmatter.id} is ${r.task.frontmatter.status}`,
  handler: async (ctx, input) => {
    const svc = await requireProject(ctx, input.projectId);
    const first = await svc.get(input.taskId);
    if (!first) throw new OpError(404, "Task not found");
    const since = input.since ?? first.frontmatter.status;
    const deadline = Date.now() + (input.timeoutSeconds ?? 30) * 1000;
    const reply = (task: typeof first, changed: boolean, timedOut: boolean) => ({
      changed,
      timedOut,
      terminal: TERMINAL.has(task.frontmatter.status),
      task: taskView(ctx, svc.projectId, task),
    });
    // Already finished, parked or at the wanted status when the call starts: nothing to wait for.
    const startStatus = first.frontmatter.status;
    if (startStatus === since && (SETTLED.has(startStatus) || startStatus === input.until)) {
      return reply(first, false, false);
    }
    let task = first;
    for (;;) {
      const status = task.frontmatter.status;
      if (status !== since || status === input.until) return reply(task, true, false);
      if (Date.now() >= deadline) return reply(task, false, true);
      await new Promise((r) => setTimeout(r, Math.min(WAIT_POLL_MS, deadline - Date.now())));
      const next = await svc.get(input.taskId);
      if (!next) throw new OpError(404, "Task not found");
      task = next;
    }
  },
});

/** An uploaded file as the REST layer hands it over (multipart `file` field). */
export interface UploadedFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}
const uploadedFile = z.custom<UploadedFile>(
  (v) => typeof v === "object" && v !== null && (v as UploadedFile).bytes instanceof Uint8Array,
  "No file provided",
);

export const attachmentName = z
  .string()
  .min(1)
  .max(255)
  .meta({ description: "Stored attachment file name." });

export const attachmentsAdd = defineOp({
  name: "tasks.attachments.add",
  title: "Attach a file to a task",
  description:
    "Uploads an image or PDF (multipart field `file`, max 25 MB) to a task. Inputs: projectId, taskId, file. Stores the file and lists it in the task.",
  scope: "tasks:write",
  projectScoped: true,
  input: z.strictObject({ projectId: projectIdParam, taskId: taskIdParam, file: uploadedFile }),
  output: TaskViewSchema,
  rest: {
    method: "POST",
    path: "/projects/{projectId}/tasks/{taskId}/attachments",
    kind: "multipart",
  },
  mcp: { expose: false },
  handler: async (ctx, input) => {
    const svc = await requireProject(ctx, input.projectId);
    const { name, type, bytes } = input.file;
    return taskView(ctx, input.projectId, await svc.addAttachment(input.taskId, name, type, bytes));
  },
});

export const attachmentsRemove = defineOp({
  name: "tasks.attachments.remove",
  title: "Remove a task attachment",
  description:
    "Deletes an attachment of a task. Inputs: projectId, taskId, attachmentName. Removes the file.",
  scope: "tasks:write",
  projectScoped: true,
  input: z.strictObject({ projectId: projectIdParam, taskId: taskIdParam, attachmentName }),
  output: TaskViewSchema,
  rest: {
    method: "DELETE",
    path: "/projects/{projectId}/tasks/{taskId}/attachments/{attachmentName}",
  },
  mcp: { expose: false },
  handler: async (ctx, input) => {
    const svc = await requireProject(ctx, input.projectId);
    return taskView(
      ctx,
      input.projectId,
      await svc.removeAttachment(input.taskId, input.attachmentName),
    );
  },
});

export const attachmentsGet = defineOp({
  name: "tasks.attachments.get",
  title: "Download a task attachment",
  description:
    "Returns an attachment's bytes with its content type. Inputs: projectId, taskId, attachmentName. No side effects.",
  scope: "tasks:read",
  projectScoped: true,
  input: z.strictObject({ projectId: projectIdParam, taskId: taskIdParam, attachmentName }),
  output: z.object({
    bytes: z.custom<Uint8Array>((v) => v instanceof Uint8Array),
    type: z.string(),
  }),
  rest: {
    method: "GET",
    path: "/projects/{projectId}/tasks/{taskId}/attachments/{attachmentName}",
    kind: "binary",
  },
  mcp: { expose: false },
  handler: async (ctx, input) => {
    const svc = await requireProject(ctx, input.projectId);
    const { bytes, type } = await svc.getAttachment(input.taskId, input.attachmentName);
    return { bytes: new Uint8Array(bytes), type };
  },
});

export const taskOps = [
  tasksList,
  tasksGet,
  tasksDiff,
  tasksCreate,
  tasksUpdate,
  tasksQueue,
  tasksSkip,
  tasksReorder,
  tasksRetry,
  tasksArchive,
  tasksUnarchive,
  tasksDelete,
  tasksAnswers,
  tasksStop,
  tasksInject,
  tasksLiveLog,
  tasksWait,
  attachmentsAdd,
  attachmentsRemove,
  attachmentsGet,
];

export type { OpContext };
