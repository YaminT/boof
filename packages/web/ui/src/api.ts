import type { CommandTemplate, HealthResult, Settings, Status, Task, TokenUsage } from "./types.js";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
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
    const res = await fetch(`/api/tasks/${id}/attachments`, { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
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
  updateSettings: (patch: Partial<Settings>) =>
    http<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),
  health: () => http<{ tools: Record<string, HealthResult> }>("/api/health").then((r) => r.tools),
  models: () => http<{ models: Record<string, string[]> }>("/api/models").then((r) => r.models),
  usage: () => http<TokenUsage>("/api/usage"),
};
