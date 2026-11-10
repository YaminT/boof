import type { ExternalStep } from "@boof/heart/schema";
import { toKebabId } from "@boof/heart/ids";
import type { N8nInfo, N8nWebhook, N8nWorkflowSummary, N8nWorkflowsResult } from "../api-types.js";
import { relativeTime } from "./time.js";

/** `key` is the React list key of a row that has no saved id yet. */
export type ExternalStepDraft = Partial<ExternalStep> & { key: string };

export const TRUST_RULE = "Only a trusted key can change external steps.";

/** The webhooks of a workflow a step may call: a single POST webhook. */
export function usableWebhooks(w: N8nWorkflowSummary): N8nWebhook[] {
  return w.webhooks.filter((h) => h.usable);
}

/** The id a row will be saved with: its own, or the kebab form of its label. */
export function stepIdOf(d: ExternalStepDraft): string {
  return d.id ?? toKebabId(d.label ?? "");
}

/** What stops each row from being saved, by row index. */
export function stepDraftErrors(steps: ExternalStepDraft[]): Record<number, string> {
  const out: Record<number, string> = {};
  const seen = new Set<string>();
  steps.forEach((s, i) => {
    const id = stepIdOf(s);
    if (!s.label?.trim() || !id) out[i] = "Give the step a label.";
    else if (seen.has(id)) out[i] = `Another step has the same id (${id}). Change the label.`;
    else if (!s.workflowId) out[i] = "Choose a workflow.";
    else if (!s.webhookPath) out[i] = "Choose a webhook.";
    if (id) seen.add(id);
  });
  return out;
}

/** A copy with the item at `from` moved to `to`; an index out of range changes nothing. */
export function moveStep<T>(steps: T[], from: number, to: number): T[] {
  if (from < 0 || from >= steps.length || to < 0 || to >= steps.length) return [...steps];
  const next = [...steps];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

/** "Not connected", "Connected to <host> · <n> workflows · refreshed <relative>" or "Last refresh failed: <reason>". */
export function n8nStatusLine(info: N8nInfo, cache: N8nWorkflowsResult, nowMs: number): string {
  if (!info.configured) return "Not connected";
  if (cache.lastError) return `Last refresh failed: ${cache.lastError}`;
  let host = info.baseUrl ?? "n8n";
  try {
    host = new URL(host).host;
  } catch {
    // show the text as it is
  }
  const n = cache.workflows.length;
  const when = cache.fetchedAt
    ? `refreshed ${relativeTime(cache.fetchedAt, nowMs)}`
    : "not refreshed yet";
  return `Connected to ${host} · ${n} ${n === 1 ? "workflow" : "workflows"} · ${when}`;
}

/** `location.hostname` is `::1`; Node's `URL.hostname` is `[::1]`. Cookie scope uses the bare host. */
function bareHostname(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

/**
 * Host-only cookies ignore the port, so a navigation to n8n on the same host name would send the
 * boof cookie. Loopback names that share a cookie jar are swapped (`127.0.0.1` ↔ `localhost`,
 * `::1` → `localhost`); both still reach a loopback listener. A link that is already on a
 * different host is left as it is.
 */
export function n8nEditorHref(editorUrl: string, pageHostname: string): string {
  let url: URL;
  try {
    url = new URL(editorUrl);
  } catch {
    return editorUrl;
  }
  const editorHost = bareHostname(url.hostname);
  const pageHost = bareHostname(pageHostname);
  if (!pageHost || editorHost !== pageHost) return editorUrl;
  const alt =
    editorHost === "localhost"
      ? "127.0.0.1"
      : editorHost === "127.0.0.1" || editorHost === "::1" || editorHost.startsWith("127.")
        ? "localhost"
        : undefined;
  if (!alt) return editorUrl;
  url.hostname = alt;
  return url.href;
}

/** The n8n connection is global and sends task content out: the local principal or a trusted, unrestricted admin key. */
export function canAdminN8n(
  w: {
    principal: { kind: string; trust: string; scopes: string[]; projects: "*" | string[] };
  } | null,
): boolean {
  if (!w) return false;
  if (w.principal.kind === "local") return true;
  return (
    w.principal.trust === "trusted" &&
    w.principal.projects === "*" &&
    w.principal.scopes.includes("admin")
  );
}

/** Steps send task content to n8n: only a trusted principal edits them. */
export function canEditExternalSteps(
  w: { principal: { kind: string; trust: string } } | null,
): boolean {
  return !!w && (w.principal.kind === "local" || w.principal.trust === "trusted");
}

/** A webhook path shown without the part that may act as a secret: its first 8 characters. */
export function shortWebhookPath(path: string): string {
  return path.length > 8 ? `${path.slice(0, 8)}…` : path;
}
