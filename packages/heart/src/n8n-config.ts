import type { N8nSettings } from "./schema.js";

/** Exactly one "/" between base and path; the base's own path (a proxy prefix) is kept. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function n8nWebhookUrl(s: N8nSettings, webhookPath: string): string {
  return joinUrl(s.webhookBaseUrl ?? joinUrl(s.baseUrl, "webhook"), webhookPath);
}

export function n8nCallbackUrl(s: N8nSettings, runId: string): string {
  return joinUrl(s.callbackBaseUrl, `callbacks/external-steps/${runId}`);
}

export function n8nEditorUrl(s: N8nSettings, workflowId: string): string {
  return joinUrl(s.baseUrl, `workflow/${workflowId}`);
}
