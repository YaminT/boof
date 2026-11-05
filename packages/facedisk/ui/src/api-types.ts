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
  via: "gateway" | "project-key" | null;
  reason: string | null;
}

/** GET /runner (the part the UI reads). */
export interface RunnerStatus {
  enabled: boolean;
  concurrency: number;
  agentAuth: AgentAuthEntry[];
}
