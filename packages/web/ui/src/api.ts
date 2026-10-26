import type {
  Project,
  ProjectPatch,
  Settings,
  SettingsPatch,
  Status,
  TokenUsage,
} from "@boof-runner/shared/schema";
import type { Task } from "@boof-runner/shared/task-types";
import type { CommandTemplate, HealthResult, PublicClient } from "./api-types.js";
import { authHeaders, notifyUnauthorized } from "./token.js";

/** Throw a readable error for a failed response; a 401 also opens the token gate. */
async function failure(res: Response, data: unknown): Promise<never> {
  if (res.status === 401) notifyUnauthorized();
  const err = (data as { error?: { message?: string } | string }).error;
  const message = typeof err === "string" ? err : err?.message;
  throw new Error(message ?? `HTTP ${res.status}`);
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
export type TaskView = Task & { projectId: string };

/** The versioned REST API; the unversioned /api/* routes are deprecated. */
const V1 = "/api/v1";
const P = (pid: string) => `${V1}/projects/${encodeURIComponent(pid)}`;
const T = (pid: string, id: string) => `${P(pid)}/tasks/${encodeURIComponent(id)}`;

/** The v1 API leaves `body.log` out of most task responses; the UI types expect a string. */
const withLog = (t: TaskView): TaskView => ({ ...t, body: { ...t.body, log: t.body.log ?? "" } });
const httpTask = (path: string, init?: RequestInit) => http<TaskView>(path, init).then(withLog);

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
  injectPrompt: (pid: string, id: string, prompt: string) =>
    http<{ ok: true }>(`${T(pid, id)}/inject`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
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
  usage: () => http<TokenUsage>(`${V1}/usage`),
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
};
