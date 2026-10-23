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
