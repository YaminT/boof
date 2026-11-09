import { mkdir, readFile } from "node:fs/promises";
import {
  dataRootPaths,
  lockedAtomicWrite,
  n8nEditorUrl,
  WEBHOOK_PATH_PATTERN,
  type N8nSettings,
} from "@boof/heart";

export interface N8nWebhook {
  path: string;
  method: string;
  /** True iff the method is POST, the path fits a step's webhook path and it is the workflow's only webhook. */
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
export interface N8nWorkflowCache {
  fetchedAt: string | null;
  workflows: N8nWorkflowSummary[];
  lastError?: string;
}

const WEBHOOK_NODE = "n8n-nodes-base.webhook";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A summary of one raw n8n workflow, or null for a shape that is not a workflow. Webhook nodes are
 * type `n8n-nodes-base.webhook` and not disabled; path = `parameters.path`, method =
 * `parameters.httpMethod ?? "GET"`. Only a POST webhook that is the workflow's single webhook, with
 * a path a step may hold, is `usable`: a step names one webhook path, so several are ambiguous.
 */
export function summarizeWorkflow(raw: unknown, settings: N8nSettings): N8nWorkflowSummary | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "number" ? String(raw.id) : raw.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  if (typeof raw.name !== "string") return null;
  const found: { path: string; method: string }[] = [];
  for (const node of Array.isArray(raw.nodes) ? raw.nodes : []) {
    if (!isRecord(node) || node.type !== WEBHOOK_NODE || node.disabled === true) continue;
    const params = isRecord(node.parameters) ? node.parameters : {};
    if (typeof params.path !== "string") continue;
    const method = typeof params.httpMethod === "string" ? params.httpMethod.toUpperCase() : "GET";
    found.push({ path: params.path, method });
  }
  const webhooks = found.map((w) => ({
    ...w,
    usable: w.method === "POST" && found.length === 1 && WEBHOOK_PATH_PATTERN.test(w.path),
  }));
  const tags = (Array.isArray(raw.tags) ? raw.tags : [])
    .map((t) => (isRecord(t) ? t.name : t))
    .filter((t): t is string => typeof t === "string");
  return {
    id,
    name: raw.name,
    active: raw.active === true,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    tags,
    webhooks,
    editorUrl: n8nEditorUrl(settings, id),
  };
}

export async function readWorkflowCache(root: string): Promise<N8nWorkflowCache> {
  try {
    const parsed: unknown = JSON.parse(await readFile(dataRootPaths(root).n8nWorkflows, "utf8"));
    if (isRecord(parsed) && Array.isArray(parsed.workflows)) {
      return {
        fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : null,
        workflows: parsed.workflows as N8nWorkflowSummary[],
        ...(typeof parsed.lastError === "string" ? { lastError: parsed.lastError } : {}),
      };
    }
  } catch {
    // missing or unreadable: an empty cache
  }
  return { fetchedAt: null, workflows: [] };
}

export async function writeWorkflowCache(root: string, cache: N8nWorkflowCache): Promise<void> {
  const paths = dataRootPaths(root);
  await mkdir(paths.n8n, { recursive: true, mode: 0o700 });
  await lockedAtomicWrite(paths.n8nWorkflows, JSON.stringify(cache, null, 2) + "\n");
}
