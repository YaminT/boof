import type {
  Epic,
  EpicPatch,
  Project,
  ProjectPatch,
  Settings,
  SettingsPatch,
  Status,
  TokenUsage,
} from "@boof/heart/schema";
import type { PublicWebhook } from "@boof/heart/schema";
import type { Task } from "@boof/heart/task-types";
import type {
  BudgetStatus,
  CommandTemplate,
  HealthResult,
  PublicClient,
  TaskDiff,
  ToolModelDetails,
  Whoami,
  AccountsHealth,
  AccountsList,
  AgentSdkEligibility,
  ConciergeAnswer,
  ConciergeAskBody,
  ConciergeEvent,
  ConciergeStatus,
  PendingChangeView,
  ProjectView,
  RunnerStatus,
} from "./api-types.js";
import { parseSse } from "./lib/concierge-stream.js";
import type { TaskReview } from "@boof/heart";
import type { Goal, GoalInput, GoalStatus, Plan, PlanStatus } from "@boof/heart";
import { authHeaders, getToken, notifyUnauthorized } from "./token.js";

/** An error response of the v1 API, with its machine-readable code and details. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
    /** A refusal that needs no message: the key was replaced or is being rotated. */
    readonly quiet = false,
  ) {
    super(message);
  }
}

/** Throw a readable error for a failed response; a 401 also opens the token gate. */
async function failure(res: Response, data: unknown, sent?: string): Promise<never> {
  // A 401 for a key that was replaced or is being rotated is not worth a message.
  const verdict = res.status === 401 ? notifyUnauthorized(sent) : undefined;
  const quiet = verdict === "stale" || verdict === "held";
  const err = (data as { error?: { message?: string; code?: string; details?: unknown } | string })
    .error;
  const message = typeof err === "string" ? err : err?.message;
  throw new ApiError(
    message ?? `HTTP ${res.status}`,
    res.status,
    typeof err === "object" ? err?.code : undefined,
    typeof err === "object" ? err?.details : undefined,
    quiet,
  );
}

async function http<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  const sent = getToken();
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...authHeaders(), ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The key changed while this request was in flight (a rotation): try once with the new one.
    if (res.status === 401 && !retried && sent !== getToken()) return http<T>(path, init, true);
    return failure(res, data, sent);
  }
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
  /** The effective epic: the task's own, or its parent's for a subtask. */
  epicId?: string;
  /** Non-archived subtasks and how many are done; present when there are any. */
  subtasks?: { total: number; done: number };
  /** The task names a parent that does not exist; it is listed as a top-level task. */
  parentMissing?: true;
  /** The task's effective epic does not exist in this project. */
  epicMissing?: true;
};

/** An epic with its progress: non-archived top-level tasks and how many are done. */
export type EpicView = Epic & { progress: { total: number; done: number } };

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
  workingDirectory?: string;
  path?:
    | { mode: "existing"; directory: string }
    | { mode: "new"; directory: string; confirm?: boolean }
    | { mode: "auto" };
  brief?: string;
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
      /** Make this a subtask (one level); it takes its parent's epic. */
      parentId?: string;
      epicId?: string;
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
      /** The `updated` the form was based on; a newer task answers 409 task_modified. */
      expectedUpdated: string;
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
  /** Move a task under a parent or into an epic; `null` clears it. Give one of the two. */
  moveTask: (
    pid: string,
    id: string,
    move: { parentId: string | null } | { epicId: string | null },
  ) => httpTask(`${T(pid, id)}/move`, { method: "POST", body: JSON.stringify(move) }),
  listEpics: (pid: string, includeArchived = false) =>
    http<{ items: EpicView[] }>(
      `${P(pid)}/epics${includeArchived ? "?includeArchived=true" : ""}`,
    ).then((r) => r.items),
  createEpic: (
    pid: string,
    input: { title: string; id?: string; description?: string; priority?: number },
  ) => http<EpicView>(`${P(pid)}/epics`, { method: "POST", body: JSON.stringify(input) }),
  updateEpic: (pid: string, epicId: string, patch: EpicPatch & { expectedUpdated?: string }) =>
    http<EpicView>(`${P(pid)}/epics/${encodeURIComponent(epicId)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  /** Refused with 409 `has_tasks` while tasks name the epic, unless `detach` clears it on them. */
  deleteEpic: (pid: string, epicId: string, detach = false) =>
    http<{ ok: true; detached: string[] }>(
      `${P(pid)}/epics/${encodeURIComponent(epicId)}${detach ? "?detach=true" : ""}`,
      { method: "DELETE" },
    ),
  /** Refused with 409 `has_children` while the task has subtasks, unless `detach` frees them. */
  deleteTask: (pid: string, id: string, detach = false) =>
    http<{ ok: true; detached: string[] }>(`${T(pid, id)}${detach ? "?detach=true" : ""}`, {
      method: "DELETE",
    }),
  liveLog: (pid: string, id: string) =>
    http<{ log: string; running: boolean }>(`${T(pid, id)}/live-log`),
  stopTask: (pid: string, id: string) =>
    http<{ ok: true }>(`${T(pid, id)}/stop`, { method: "POST" }),
  injectPrompt: (
    pid: string,
    id: string,
    prompt: string,
    mode: "next-step" | "now" = "next-step",
    /** Switch the running step to this model; only with mode "now". */
    model?: string,
  ) =>
    http<{ ok: true; mode: "next-step" | "now"; applied: "pending" }>(`${T(pid, id)}/inject`, {
      method: "POST",
      body: JSON.stringify(model && mode === "now" ? { prompt, mode, model } : { prompt, mode }),
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
  updateSettings: (
    patch: SettingsPatch & { owlishApiKey?: string | null; owlishAgentKey?: string | null },
  ) => http<Settings>(`${V1}/settings`, { method: "PUT", body: JSON.stringify(patch) }),
  accountsHealth: (refresh = false) =>
    http<AccountsHealth>(`${V1}/accounts/health${refresh ? "?refresh=true" : ""}`),
  listAccounts: () => http<AccountsList>(`${V1}/accounts`),
  /** May claude-agent use the gateway, and which accounts block it. */
  agentSdkEligibility: (refresh = false) =>
    http<AgentSdkEligibility>(`${V1}/accounts/agent-sdk${refresh ? "?refresh=true" : ""}`),
  /** Runner state, with the claude-agent authentication result per project. */
  runnerStatus: () => http<RunnerStatus>(`${V1}/runner`),
  accountAction: (verb: "pause" | "resume", accountId: string) =>
    http<{ ok: true }>(`${V1}/accounts/${encodeURIComponent(accountId)}/${verb}`, {
      method: "POST",
      body: "{}",
    }),
  accountPriority: (accountId: string, priority: number) =>
    http<{ ok: true }>(`${V1}/accounts/${encodeURIComponent(accountId)}/priority`, {
      method: "POST",
      body: JSON.stringify({ priority }),
    }),
  accountThresholds: (accountId: string, thresholds: Record<string, number | null>) =>
    http<{ ok: true }>(`${V1}/accounts/${encodeURIComponent(accountId)}/thresholds`, {
      method: "POST",
      body: JSON.stringify({ thresholds }),
    }),
  /** Runs the tools' version probes (POST), then returns their results. GET /health only reads the last ones. */
  health: () =>
    http<{ tools: Record<string, HealthResult> }>(`${V1}/health/check`, { method: "POST" }).then(
      (r) => r.tools,
    ),
  /** Asks the tools for their models (POST). GET /models only reads the last lists. */
  models: () =>
    http<{ models: Record<string, string[]> }>(`${V1}/models/refresh`, { method: "POST" }).then(
      (r) => r.models,
    ),
  modelDetails: () =>
    http<{ tools: Record<string, ToolModelDetails> }>(`${V1}/models/details`).then((r) => r.tools),
  usage: () => http<TokenUsage>(`${V1}/usage`),
  budget: () => http<BudgetStatus>(`${V1}/usage/budget`),
  projectUsage: (pid: string) => http<TokenUsage>(`${P(pid)}/usage`),

  listProjects: (includeArchived = false) =>
    http<{ projects: ProjectView[] }>(
      `${V1}/projects${includeArchived ? "?includeArchived=1" : ""}`,
    ).then((r) => r.projects),
  getProject: (pid: string) => http<ProjectView>(P(pid)),
  createProject: (input: CreateProjectInput) =>
    http<Project>(`${V1}/projects`, { method: "POST", body: JSON.stringify(input) }),
  updateProject: (pid: string, patch: ProjectPatch & { anthropicApiKey?: string | null }) =>
    http<ProjectView>(P(pid), { method: "PUT", body: JSON.stringify(patch) }),
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

  listWebhooks: () => http<{ webhooks: PublicWebhook[] }>(`${V1}/webhooks`).then((r) => r.webhooks),
  createWebhook: (input: { url: string; events: string[]; projects: "*" | string[] }) =>
    http<{ webhook: PublicWebhook; secret: string }>(`${V1}/webhooks`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateWebhook: (
    id: string,
    patch: Partial<{ url: string; events: string[]; projects: "*" | string[]; enabled: boolean }>,
  ) =>
    http<PublicWebhook>(`${V1}/webhooks/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  deleteWebhook: (id: string) =>
    http<{ ok: true }>(`${V1}/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  whoami: () => http<Whoami>(`${V1}/whoami`),
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

  conciergeStatus: (pid: string) => http<ConciergeStatus>(`${P(pid)}/concierge`),
  conciergeAsk: (pid: string, body: ConciergeAskBody) =>
    http<ConciergeAnswer>(`${P(pid)}/concierge/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  conciergeApply: (pid: string, changeId: string) =>
    http<{ change: PendingChangeView; result: unknown }>(
      `${P(pid)}/concierge/changes/${encodeURIComponent(changeId)}/apply`,
      { method: "POST" },
    ),
  conciergeDiscard: (pid: string, changeId: string) =>
    http<{ change: PendingChangeView }>(
      `${P(pid)}/concierge/changes/${encodeURIComponent(changeId)}/discard`,
      { method: "POST" },
    ),
  conciergeReset: (pid: string) =>
    http<{ ok: true }>(`${P(pid)}/concierge/reset`, { method: "POST" }),
  /**
   * POST the message and read typed SSE events. A non-2xx answer is JSON (the same error as
   * `http`) and never opens the stream. The key travels in `Authorization`, never in the URL.
   */
  conciergeStream: (
    pid: string,
    body: ConciergeAskBody,
    onEvent: (event: ConciergeEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> => readConciergeStream(pid, body, onEvent, signal, false),
};

async function readConciergeStream(
  pid: string,
  body: ConciergeAskBody,
  onEvent: (event: ConciergeEvent) => void,
  signal: AbortSignal | undefined,
  retried: boolean,
): Promise<void> {
  const sent = getToken();
  const res = await fetch(`${P(pid)}/concierge/messages/stream`, {
    method: "POST",
    body: JSON.stringify(body),
    signal,
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...authHeaders(),
    },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !retried && sent !== getToken()) {
      return readConciergeStream(pid, body, onEvent, signal, true);
    }
    return failure(res, data, sent);
  }
  if (!res.body) throw new ApiError("The assistant stream was empty", res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  const emit = (events: { data: string }[]) => {
    for (const event of events) {
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        throw new ApiError("The assistant stream sent invalid data", 502, "internal");
      }
      if (typeof data !== "object" || data === null || !("type" in data)) {
        throw new ApiError("The assistant stream sent invalid data", 502, "internal");
      }
      onEvent(data as ConciergeEvent);
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail) {
          const parsed = parseSse(carry, tail);
          carry = parsed.carry;
          emit(parsed.events);
        }
        break;
      }
      const parsed = parseSse(carry, decoder.decode(value, { stream: true }));
      carry = parsed.carry;
      emit(parsed.events);
    }
  } finally {
    reader.releaseLock();
  }
}

export type { Goal, GoalInput, GoalStatus, Plan, PlanStatus };
