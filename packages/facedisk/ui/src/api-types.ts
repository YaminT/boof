// UI-only response shapes that have no counterpart in the shared schema.
import type { Project, Role, Scope } from "@boof/heart/schema";
export type PoolState = "absent" | "unreachable" | "ok" | "degraded" | "unhealthy";
export interface PoolStatus {
  status: PoolState;
  configured: number | null;
  routable: number | null;
  paused: number | null;
  rateLimited: number | null;
  usageExhausted: number | null;
  nextAvailableAt: string | null;
  reason: string | null;
}
export interface AccountSummary {
  id: string;
  name: string;
  provider?: string;
  priority?: number;
  paused?: boolean;
  tokenStatus?: string;
  rateLimitStatus?: string;
  rateLimitReset?: string | number | null;
  [extra: string]: unknown;
}
export type Thresholds = Record<string, number | null>;

export interface AccountsHealth {
  configured: boolean;
  url: string | null;
  healthGate: "pause" | "warn" | "off" | null;
  keySource: "file" | "env" | null;
  agentKeySource: "file" | "env" | null;
  pool: PoolStatus;
}
export interface AccountsList {
  configured: boolean;
  accounts: AccountSummary[];
}

export interface CommandTemplate {
  id: string;
  name: string;
  body: string;
}

export interface HealthResult {
  status: "available" | "unavailable";
  message: string;
  version?: string;
  /** Why the tool cannot run in this install at all (the desktop app and claude-agent). */
  unavailableReason?: string;
}

/** One model of a tool as GET /api/v1/models/details reports it. */
export interface ModelDetail {
  id: string;
  source: "cli" | "default" | "settings";
  isDefault: boolean;
  /** Roles ("planner", …) and "project:<id>:<role>" entries that use this tool and model. */
  usedBy: string[];
}

export interface ToolModelDetails {
  displayName: string;
  /** Set when the tool cannot be chosen in this install; the UI lists it as unavailable. */
  unavailableReason?: string;
  /** Last health check of this server process, or null when none ran. */
  health: (HealthResult & { checkedAt: string }) | null;
  models: ModelDetail[];
}

/** One budget scope as GET /usage/budget returns it. */
export interface BudgetScope {
  /** `global`, `project:<id>`, `tool:<tool>` or `project:<id>/tool:<tool>`. */
  scope: string;
  spentUsd: number;
  limitUsd: number | null;
  remainingUsd: number | null;
  exceeded: boolean;
}

/** GET /usage/budget. */
export interface BudgetStatus {
  date: string;
  timezone: string;
  resetsAt: string;
  unknownSteps: number;
  scopes: BudgetScope[];
  exceeded: BudgetScope[];
}

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "binary";

/** What `GET .../tasks/{id}/diff` returns (see docs/api.md). */
export interface TaskDiff {
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  files: {
    path: string;
    oldPath?: string;
    status: DiffFileStatus;
    additions: number;
    deletions: number;
  }[];
  stats: { files: number; additions: number; deletions: number };
  patch?: string;
  truncated: boolean;
  commits: { sha: string; subject: string; author: string; date: string }[];
  includesUncommitted?: boolean;
  leftovers?: { ref: string; sha: string };
}

/** An API client as returned by /api/auth/clients (never includes the key hash). */
export interface PublicClient {
  id: string;
  name: string;
  kind: "harness" | "mcp" | "ui" | "cli";
  scopes: string[];
  projects: "*" | string[];
  trust: "trusted" | "review";
  created: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

/** GET /api/v1/whoami: the calling principal and basic facts of the server. */
export interface Whoami {
  principal: {
    kind: "local" | "client";
    id: string;
    name: string;
    trust: "trusted" | "review";
    scopes: Scope[];
    projects: "*" | string[];
    /** When the calling key expires; absent when it never does. */
    expiresAt?: string;
  };
  server: { version: string; authMode: "local-trust" | "required"; mcpEnabled: boolean };
}

/** A project as the project operations return it: the stored project plus whether a key is stored. */
export type ProjectView = Project & {
  /** True when this project has its own Anthropic API key. The key itself is never returned. */
  anthropicApiKeySet?: boolean;
};

/** GET /accounts/agent-sdk: may claude-agent use the gateway? */
export interface AgentSdkEligibility {
  gateway: "absent" | "checked";
  allowed: boolean;
  reason: string;
  blocking: {
    id: string;
    name: string;
    provider: string | null;
    why: "subscription" | "oauth-token" | "unknown-type";
  }[];
  checkedAt?: string;
}

/** One project of `runner.status.agentAuth`: may its claude-agent roles start, and how. */
export interface AgentAuthEntry {
  projectId: string;
  roles: Role[];
  allowed: boolean;
  via: "gateway" | "project-key" | "claude-code" | null;
  reason: string | null;
}

/** GET /runner (the part the UI reads). */
export interface RunnerStatus {
  enabled: boolean;
  concurrency: number;
  agentAuth: AgentAuthEntry[];
  /** OS sandbox gate. `offer` is the last capability check; a missing value means it has not passed. */
  sandbox?: {
    mode: "off" | "enforce";
    backend: "none" | "linux" | "darwin";
    state: "off" | "ok" | "unavailable";
    reason: string;
    offer?: boolean;
  };
}

/**
 * Page context sent with an assistant message. Mirrors `ConciergeAskInputSchema`'s `context`.
 * The server resolves titles; the browser sends only the screen and ids.
 */
export interface ConciergeContext {
  screen: "overview" | "tasks" | "task" | "plans" | "settings" | "inbox";
  taskId?: string;
  planId?: string;
  goalId?: string;
}

/** A pending change as the concierge operations return it. The title and details are plain text. */
export interface PendingChangeView {
  id: string;
  op: string;
  title: string;
  details: string[];
  destructive: boolean;
  /** Why confirming can only fail. The dialog shows it and offers no Confirm or Apply. */
  blocked?: string;
  /** Why a failed change failed (for example "interrupted"). */
  error?: string;
  reason: "confirm" | "needs-approval";
  status: "pending" | "applying" | "applied" | "discarded" | "expired" | "failed";
  expiresAt: string;
}

export interface ConciergeChangeTarget {
  kind: "task" | "plan" | "epic";
  id: string;
}

/** POST /projects/{projectId}/concierge/messages. */
export interface ConciergeAnswer {
  conversationId: string;
  text: string;
  changes: { op: string; summary: string; target: ConciergeChangeTarget | null }[];
  pending: PendingChangeView[];
  costUsd: number | null;
  stopReason: "done" | "max_turns" | "max_budget";
}

/** GET /projects/{projectId}/concierge. */
export interface ConciergeStatus {
  available: boolean;
  reason: string | null;
  via: "gateway" | "project-key" | "claude-code" | null;
  model: string;
  limits: { perMessageUsd: number; perConversationUsd: number; messagesPerMinute: number };
  conversation: {
    id: string;
    spentUsd: number;
    messages: number;
    pending: PendingChangeView[];
  } | null;
}

/** One SSE event from POST .../concierge/messages/stream. `data` is this object as JSON. */
export type ConciergeEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; phase: "start" | "end"; ok?: boolean }
  | { type: "change"; op: string; summary: string; target: ConciergeChangeTarget | null }
  | { type: "pending"; change: PendingChangeView }
  | { type: "done"; answer: ConciergeAnswer }
  | { type: "error"; code: string; message: string };

/** Body of concierge.ask and the stream route. The project id stays in the path. */
export interface ConciergeAskBody {
  text: string;
  context?: ConciergeContext;
  conversationId?: string;
}

/** One webhook node of an n8n workflow; only a single POST webhook is `usable` for a step. */
export interface N8nWebhook {
  path: string;
  method: string;
  usable: boolean;
}
export interface N8nWorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  updatedAt: string;
  tags: string[];
  webhooks: N8nWebhook[];
  editorUrl: string;
}
/** GET /n8n: the connection, never the API key or the webhook secret. */
export interface N8nInfo {
  configured: boolean;
  baseUrl?: string;
  webhookBaseUrl?: string;
  callbackBaseUrl?: string;
  defaultTimeoutMs?: number;
  checks?: { enabled: boolean; projectId: string; autoQueue: boolean; pollIntervalMs: number };
  apiKeySet: boolean;
  apiKeySource: "env" | "file" | null;
  webhookSecretSet: boolean;
}
/** PUT /n8n: the secret is present only when it was created or rotated; `notice` explains a dropped key. */
export type N8nUpdateResult = N8nInfo & { secret?: string; notice?: string };
export interface N8nWorkflowsResult {
  configured: boolean;
  fetchedAt: string | null;
  workflows: N8nWorkflowSummary[];
  lastError?: string;
}
export interface N8nUpdateInput {
  baseUrl?: string;
  webhookBaseUrl?: string | null;
  callbackBaseUrl?: string;
  defaultTimeoutMs?: number;
  checks?: {
    enabled: boolean;
    projectId: string;
    autoQueue: boolean;
    pollIntervalMs: number;
  } | null;
  apiKey?: string | null;
  rotateWebhookSecret?: boolean;
}
