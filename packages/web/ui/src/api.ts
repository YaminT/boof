import type {
  Project,
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

export const api = {
  listTasks: () => http<{ tasks: Task[] }>("/api/tasks").then((r) => r.tasks),
  getTask: (id: string) => http<Task>(`/api/tasks/${id}`),
  createTask: (input: {
    title: string;
    prompt?: string;
    priority?: number;
    labels?: string[];
    command?: string | null;
    status?: "draft" | "pending";
    runs?: number;
  }) => http<Task>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),
  updateTask: (
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
  ) => http<Task>(`/api/tasks/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  setSkip: (id: string, skip: boolean) =>
    http<Task>(`/api/tasks/${id}/skip`, { method: "POST", body: JSON.stringify({ skip }) }),
  reorder: (order: string[]) =>
    http<{ tasks: Task[] }>("/api/tasks/reorder", {
      method: "POST",
      body: JSON.stringify({ order }),
    }),
  retry: (id: string) => http<Task>(`/api/tasks/${id}/retry`, { method: "POST" }),
  archive: (id: string) => http<Task>(`/api/tasks/${id}/archive`, { method: "POST" }),
  unarchive: (id: string) => http<Task>(`/api/tasks/${id}/unarchive`, { method: "POST" }),
  deleteTask: (id: string) => http<{ ok: true }>(`/api/tasks/${id}`, { method: "DELETE" }),
  liveLog: (id: string) => http<{ log: string; running: boolean }>(`/api/tasks/${id}/live-log`),
  stopTask: (id: string) => http<{ ok: true }>(`/api/tasks/${id}/stop`, { method: "POST" }),
  injectPrompt: (id: string, prompt: string) =>
    http<{ ok: true }>(`/api/tasks/${id}/inject`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
    }),
  submitAnswers: (id: string, answers: string) =>
    http<Task>(`/api/tasks/${id}/answers`, { method: "POST", body: JSON.stringify({ answers }) }),

  uploadAttachment: async (id: string, file: File): Promise<Task> => {
    const form = new FormData();
    form.append("file", file);
    // No content-type header: the browser sets the multipart boundary.
    const res = await fetch(`/api/tasks/${id}/attachments`, {
      method: "POST",
      body: form,
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return failure(res, data);
    return data as Task;
  },
  deleteAttachment: (id: string, name: string) =>
    http<Task>(`/api/tasks/${id}/attachments/${encodeURIComponent(name)}`, { method: "DELETE" }),
  attachmentUrl: (id: string, name: string) =>
    `/api/tasks/${id}/attachments/${encodeURIComponent(name)}`,

  listCommands: () =>
    http<{ commands: CommandTemplate[] }>("/api/commands").then((r) => r.commands),
  upsertCommand: (name: string, body: string) =>
    http<CommandTemplate>("/api/commands", {
      method: "POST",
      body: JSON.stringify({ name, body }),
    }),
  renameCommand: (id: string, name: string, body: string) =>
    http<CommandTemplate>(`/api/commands/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name, body }),
    }),
  deleteCommand: (id: string) =>
    http<{ referencedBy: string[] }>(`/api/commands/${id}`, { method: "DELETE" }),

  getSettings: () => http<Settings>("/api/settings"),
  updateSettings: (patch: SettingsPatch) =>
    http<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),
  health: () => http<{ tools: Record<string, HealthResult> }>("/api/health").then((r) => r.tools),
  models: () => http<{ models: Record<string, string[]> }>("/api/models").then((r) => r.models),
  usage: () => http<TokenUsage>("/api/usage"),
  // Minimal project support: the UI still works against the default project (legacy /api/tasks).
  getProject: (id: string) => http<Project>(`/api/projects/${id}`),
  createProject: (input: { workingDirectory: string }) =>
    http<Project>("/api/projects", { method: "POST", body: JSON.stringify(input) }),
  updateProject: (id: string, patch: { workingDirectory?: string }) =>
    http<Project>(`/api/projects/${id}`, { method: "PUT", body: JSON.stringify(patch) }),

  /** Fetch an attachment with the auth header and return a blob: URL for <img>/<a>. */
  attachmentBlobUrl: async (id: string, name: string): Promise<string> => {
    const res = await fetch(api.attachmentUrl(id, name), { headers: authHeaders() });
    if (!res.ok) return failure(res, await res.json().catch(() => ({})));
    return URL.createObjectURL(await res.blob());
  },

  listClients: () => http<{ clients: PublicClient[] }>("/api/auth/clients").then((r) => r.clients),
  createClient: (input: {
    name: string;
    kind?: "harness" | "mcp" | "cli";
    scopes: string[];
    projects?: "*" | string[];
    trust?: "trusted" | "review";
    expiresIn?: string;
  }) =>
    http<{ client: PublicClient; key: string }>("/api/auth/clients", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revokeClient: (id: string) =>
    http<{ client: PublicClient }>(`/api/auth/clients/${id}/revoke`, { method: "POST" }),
  rotateClient: (id: string) =>
    http<{ client: PublicClient; key: string }>(`/api/auth/clients/${id}/rotate`, {
      method: "POST",
    }),
};
