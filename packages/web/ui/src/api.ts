import type {
  Project,
  ProjectPatch,
  Settings,
  SettingsPatch,
  Status,
  TokenUsage,
} from "@boof-runner/shared/schema";
import type { Task } from "@boof-runner/shared/task-types";
import type {
  BudgetStatus,
  CommandTemplate,
  HealthResult,
  PublicClient,
  TaskDiff,
  ToolModelDetails,
} from "./api-types.js";
import type { TaskReview } from "@boof-runner/shared";
import type { Goal, GoalInput, GoalStatus, Plan, PlanStatus } from "@boof-runner/shared";
import { authHeaders, notifyUnauthorized } from "./token.js";

/** An error response of the v1 API, with its machine-readable code and details. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Throw a readable error for a failed response; a 401 also opens the token gate. */
async function failure(res: Response, data: unknown): Promise<never> {
  if (res.status === 401) notifyUnauthorized();
  const err = (data as { error?: { message?: string; code?: string; details?: unknown } | string })
    .error;
  const message = typeof err === "string" ? err : err?.message;
  throw new ApiError(
    message ?? `HTTP ${res.status}`,
    res.status,
    typeof err === "object" ? err?.code : undefined,
    typeof err === "object" ? err?.details : undefined,
  );
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...authHeaders(), ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return failure(res, data);
  return data as T;
}

/** A task as returned by the project routes: the task plus the project that owns it. */
export type TaskView = Task & {
  projectId: string;
  /** Observer and reviewer rounds parsed from the reports, oldest first. */
  reviews?: TaskReview[];
  /** The verdict of the last round of each role that reviewed. */
  finalVerdict?: { observer?: TaskReview["verdict"]; reviewer?: TaskReview["verdict"] };
  branch?: string;
};

/** The versioned REST API; the unversioned /api/* routes are deprecated. */
// Relative so the UI also works behind a reverse-proxy path prefix (https://host/boof/).
const V1 = "api/v1";
const P = (pid: string) => `${V1}/projects/${encodeURIComponent(pid)}`;
const T = (pid: string, id: string) => `${P(pid)}/tasks/${encodeURIComponent(id)}`;

/** The v1 API leaves `body.log` out of most task responses; the UI types expect a string. */
const withLog = (t: TaskView): TaskView => ({ ...t, body: { ...t.body, log: t.body.log ?? "" } });
const httpTask = (path: string, init?: RequestInit) => http<TaskView>(path, init).then(withLog);

/** A plan in the list: no goals, with progress counters. */
export type PlanSummary = Omit<Plan, "goals"> & { goalCount: number; doneCount: number };

export interface SyncReport {
  created: { goalId: string; taskId: string; revision: number; status: string; skip: boolean }[];
  updated: { goalId: string; taskId: string; revision: number; action: string }[];
  skipped: { goalId: string; taskId: string; reason: string }[];
  archived: { goalId: string; taskId: string; action: string; reason: string }[];
  dryRun: boolean;
  plan: Plan;
}

export interface ImportReport {
  plan: Plan;
  added: string[];
  updated: string[];
  unchanged: string[];
  warnings: string[];
}

const PL = (pid: string, planId: string) => `${P(pid)}/plans/${encodeURIComponent(planId)}`;
const ifMatch = (version: number) => ({ "If-Match": `"${version}"` });
const json = (method: string, body: unknown, version?: number): RequestInit => ({
  method,
  body: JSON.stringify(body),
  ...(version !== undefined ? { headers: ifMatch(version) } : {}),
});

export interface CreateProjectInput {
  workingDirectory: string;
  id?: string;
  name?: string;
  defaultBase?: string;
  labels?: string[];
}

export const api = {
  /** All tasks of a project, without their logs: follows the cursor pages of the v1 list. */
  listTasks: async (pid: string): Promise<TaskView[]> => {
    const out: TaskView[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: TaskView[]; nextCursor: string | null } = await http(
        `${P(pid)}/tasks?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      out.push(...page.items.map(withLog));
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  },
  /** One task with its log (`include=log`; the v1 default leaves the log out). */
  getTask: (pid: string, id: string) => http<TaskView>(`${T(pid, id)}?include=log`).then(withLog),
  /** What the task's branch changed; `path` limits the patch to one file. */
  getTaskDiff: (pid: string, id: string, opts: { path?: string } = {}) =>
    http<TaskDiff>(
      `${T(pid, id)}/diff${opts.path !== undefined ? `?path=${encodeURIComponent(opts.path)}` : ""}`,
    ),
  createTask: (
    pid: string,
    input: {
      title: string;
      prompt?: string;
      priority?: number;
      labels?: string[];
      command?: string | null;
      status?: "draft" | "pending";
      runs?: number;
    },
  ) => httpTask(`${P(pid)}/tasks`, { method: "POST", body: JSON.stringify(input) }),
  updateTask: (
    pid: string,
    id: string,
    input: Partial<{
      title: string;
      prompt: string;
      priority: number;
      labels: string[];
      command: string | null;
      skip: boolean;
      runs: number;
      status: Status;
    }>,
  ) => httpTask(T(pid, id), { method: "PUT", body: JSON.stringify(input) }),
  setSkip: (pid: string, id: string, skip: boolean) =>
    httpTask(`${T(pid, id)}/skip`, { method: "POST", body: JSON.stringify({ skip }) }),
  reorder: (pid: string, order: string[]) =>
    http<{ tasks: TaskView[] }>(`${P(pid)}/tasks/reorder`, {
      method: "POST",
      body: JSON.stringify({ order }),
    }).then((r) => ({ tasks: r.tasks.map(withLog) })),
  retry: (pid: string, id: string) => httpTask(`${T(pid, id)}/retry`, { method: "POST" }),
  archive: (pid: string, id: string) => httpTask(`${T(pid, id)}/archive`, { method: "POST" }),
  unarchive: (pid: string, id: string) => httpTask(`${T(pid, id)}/unarchive`, { method: "POST" }),
  deleteTask: (pid: string, id: string) => http<{ ok: true }>(T(pid, id), { method: "DELETE" }),
  liveLog: (pid: string, id: string) =>
    http<{ log: string; running: boolean }>(`${T(pid, id)}/live-log`),
  stopTask: (pid: string, id: string) =>
    http<{ ok: true }>(`${T(pid, id)}/stop`, { method: "POST" }),
  injectPrompt: (
    pid: string,
    id: string,
    prompt: string,
    mode: "next-step" | "now" = "next-step",
  ) =>
    http<{ ok: true; mode: "next-step" | "now"; applied: "pending" }>(`${T(pid, id)}/inject`, {
      method: "POST",
      body: JSON.stringify({ prompt, mode }),
    }),
  submitAnswers: (pid: string, id: string, answers: string) =>
    httpTask(`${T(pid, id)}/answers`, { method: "POST", body: JSON.stringify({ answers }) }),
  actions: () => http<{ actions: TaskView[] }>(`${V1}/actions`).then((r) => r.actions.map(withLog)),

  uploadAttachment: async (pid: string, id: string, file: File): Promise<TaskView> => {
    const form = new FormData();
    form.append("file", file);
    // No content-type header: the browser sets the multipart boundary.
    const res = await fetch(`${T(pid, id)}/attachments`, {
      method: "POST",
      body: form,
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return failure(res, data);
    return withLog(data as TaskView);
  },
  deleteAttachment: (pid: string, id: string, name: string) =>
    httpTask(`${T(pid, id)}/attachments/${encodeURIComponent(name)}`, { method: "DELETE" }),
  attachmentUrl: (pid: string, id: string, name: string) =>
    `${T(pid, id)}/attachments/${encodeURIComponent(name)}`,

  listCommands: () =>
    http<{ commands: CommandTemplate[] }>(`${V1}/commands`).then((r) => r.commands),
  upsertCommand: (name: string, body: string) =>
    http<CommandTemplate>(`${V1}/commands`, {
      method: "POST",
      body: JSON.stringify({ name, body }),
    }),
  renameCommand: (id: string, name: string, body: string) =>
    http<CommandTemplate>(`${V1}/commands/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name, body }),
    }),
  deleteCommand: (id: string) =>
    http<{ referencedBy: string[] }>(`${V1}/commands/${id}`, { method: "DELETE" }),

  getSettings: () => http<Settings>(`${V1}/settings`),
  updateSettings: (patch: SettingsPatch) =>
    http<Settings>(`${V1}/settings`, { method: "PUT", body: JSON.stringify(patch) }),
  health: () => http<{ tools: Record<string, HealthResult> }>(`${V1}/health`).then((r) => r.tools),
  models: () => http<{ models: Record<string, string[]> }>(`${V1}/models`).then((r) => r.models),
  modelDetails: () =>
    http<{ tools: Record<string, ToolModelDetails> }>(`${V1}/models/details`).then((r) => r.tools),
  usage: () => http<TokenUsage>(`${V1}/usage`),
  budget: () => http<BudgetStatus>(`${V1}/usage/budget`),
  projectUsage: (pid: string) => http<TokenUsage>(`${P(pid)}/usage`),

  listProjects: (includeArchived = false) =>
    http<{ projects: Project[] }>(
      `${V1}/projects${includeArchived ? "?includeArchived=1" : ""}`,
    ).then((r) => r.projects),
  getProject: (pid: string) => http<Project>(P(pid)),
  createProject: (input: CreateProjectInput) =>
    http<Project>(`${V1}/projects`, { method: "POST", body: JSON.stringify(input) }),
  updateProject: (pid: string, patch: ProjectPatch) =>
    http<Project>(P(pid), { method: "PUT", body: JSON.stringify(patch) }),
  archiveProject: (pid: string) => http<Project>(`${P(pid)}/archive`, { method: "POST" }),
  unarchiveProject: (pid: string) => http<Project>(`${P(pid)}/unarchive`, { method: "POST" }),
  pauseProject: (pid: string) => http<Project>(`${P(pid)}/pause`, { method: "POST" }),
  resumeProject: (pid: string) => http<Project>(`${P(pid)}/resume`, { method: "POST" }),
  deleteProject: (pid: string, purge = false) =>
    http<{ ok: true }>(`${P(pid)}${purge ? "?purge=1" : ""}`, { method: "DELETE" }),

  /** Fetch an attachment with the auth header and return a blob: URL for <img>/<a>. */
  attachmentBlobUrl: async (pid: string, id: string, name: string): Promise<string> => {
    const res = await fetch(api.attachmentUrl(pid, id, name), { headers: authHeaders() });
    if (!res.ok) return failure(res, await res.json().catch(() => ({})));
    return URL.createObjectURL(await res.blob());
  },

  listClients: () => http<{ clients: PublicClient[] }>(`${V1}/auth/clients`).then((r) => r.clients),
  createClient: (input: {
    name: string;
    kind?: "harness" | "mcp" | "cli";
    scopes: string[];
    projects?: "*" | string[];
    trust?: "trusted" | "review";
    expiresIn?: string;
  }) =>
    http<{ client: PublicClient; key: string }>(`${V1}/auth/clients`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revokeClient: (id: string) =>
    http<{ client: PublicClient }>(`${V1}/auth/clients/${id}/revoke`, { method: "POST" }),
  rotateClient: (id: string) =>
    http<{ client: PublicClient; key: string }>(`${V1}/auth/clients/${id}/rotate`, {
      method: "POST",
    }),

  listPlans: (pid: string) =>
    http<{ plans: PlanSummary[] }>(`${P(pid)}/plans`).then((r) => r.plans),
  getPlan: (pid: string, planId: string) => http<Plan>(PL(pid, planId)),
  createPlan: (pid: string, input: { title: string; description?: string; goals?: GoalInput[] }) =>
    http<Plan>(`${P(pid)}/plans`, json("POST", { goals: [], ...input })),
  updatePlan: (
    pid: string,
    plan: { id: string; version: number },
    patch: Partial<{
      title: string;
      description: string;
      status: PlanStatus;
      autoSync: boolean;
      bumpTo: "review" | "done";
    }>,
  ) => http<Plan>(PL(pid, plan.id), json("PUT", patch, plan.version)),
  putGoal: (pid: string, plan: { id: string; version: number }, goal: GoalInput) =>
    http<Plan>(
      `${PL(pid, plan.id)}/goals/${encodeURIComponent(goal.id)}`,
      json("PUT", goal, plan.version),
    ),
  deleteGoal: (
    pid: string,
    plan: { id: string; version: number },
    goalId: string,
    cascade = false,
  ) =>
    http<Plan>(
      `${PL(pid, plan.id)}/goals/${encodeURIComponent(goalId)}${cascade ? "?cascade=1&stopRunning=1" : ""}`,
      { method: "DELETE", headers: ifMatch(plan.version) },
    ),
  reorderGoals: (pid: string, plan: { id: string; version: number }, order: string[]) =>
    http<Plan>(`${PL(pid, plan.id)}/reorder`, json("POST", { order }, plan.version)),
  setGoalStatus: (
    pid: string,
    plan: { id: string; version: number },
    goalId: string,
    status: GoalStatus,
  ) =>
    http<Plan>(
      `${PL(pid, plan.id)}/goals/${encodeURIComponent(goalId)}/status`,
      json("POST", { status }, plan.version),
    ),
  importPlan: (pid: string, input: { planId?: string; merge?: boolean } = {}) =>
    http<ImportReport>(`${P(pid)}/plans/import`, json("POST", input)),
  exportPlan: (pid: string, planId: string) =>
    http<Record<string, string>>(`${PL(pid, planId)}/export`),
  syncPlan: (pid: string, planId: string, dryRun: boolean) =>
    http<SyncReport>(`${PL(pid, planId)}/sync`, json("POST", { dryRun })),
};

export type { Goal, GoalInput, GoalStatus, Plan, PlanStatus };
