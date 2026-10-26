// UI-only response shapes that have no counterpart in the shared schema.

export interface CommandTemplate {
  id: string;
  name: string;
  body: string;
}

export interface HealthResult {
  status: "available" | "unavailable";
  message: string;
  version?: string;
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
  /** Last health check of this server process, or null when none ran. */
  health: (HealthResult & { checkedAt: string }) | null;
  models: ModelDetail[];
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
