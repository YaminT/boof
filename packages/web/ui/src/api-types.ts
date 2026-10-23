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
