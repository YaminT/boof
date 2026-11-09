import { rm } from "node:fs/promises";
import { z } from "zod";
import {
  dataRootPaths,
  N8nSecretStore,
  N8nSettingsSchema,
  securitySettings,
  type N8nSettings,
} from "@boof/heart";
import { checkN8nTarget, N8nClient } from "../../n8n/client.js";
import { readWorkflowCache } from "../../n8n/workflows.js";
import { defineOp, type OpContext } from "../define-op.js";
import { OpError } from "../errors.js";
import { assertMayWriteSettings } from "./admin.js";
import { DESTRUCTIVE, IDEMPOTENT_WRITE, READ } from "./common.js";

const WorkflowSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  updatedAt: z.string(),
  tags: z.array(z.string()),
  webhooks: z.array(z.object({ path: z.string(), method: z.string(), usable: z.boolean() })),
  editorUrl: z.string(),
});

const N8nInfoSchema = z.object({
  configured: z.boolean(),
  baseUrl: z.string().optional(),
  webhookBaseUrl: z.string().optional(),
  callbackBaseUrl: z.string().optional(),
  defaultTimeoutMs: z.number().optional(),
  checks: z
    .object({
      enabled: z.boolean(),
      projectId: z.string(),
      autoQueue: z.boolean(),
      pollIntervalMs: z.number(),
    })
    .optional(),
  apiKeySet: z.boolean(),
  apiKeySource: z.enum(["env", "file"]).nullable(),
  webhookSecretSet: z.boolean(),
});
export type N8nInfo = z.infer<typeof N8nInfoSchema>;

const WorkflowsResultSchema = z.object({
  configured: z.boolean(),
  fetchedAt: z.string().nullable(),
  workflows: z.array(WorkflowSummarySchema),
  lastError: z.string().optional(),
});
export type N8nWorkflowsResult = z.infer<typeof WorkflowsResultSchema>;

const shape = N8nSettingsSchema.shape;
const API_KEY_PATTERN = /^[\x21-\x7e]{1,2048}$/;

const N8nUpdateInput = z.strictObject({
  baseUrl: shape.baseUrl.optional(),
  webhookBaseUrl: shape.baseUrl.nullable().optional(),
  callbackBaseUrl: shape.callbackBaseUrl.optional(),
  defaultTimeoutMs: z.number().int().min(10_000).max(86_400_000).optional(),
  checks: shape.checks.unwrap().nullable().optional(),
  apiKey: z.string().regex(API_KEY_PATTERN).nullable().optional().meta({
    description:
      "The n8n API key. Write-only: stored apart from settings.json (n8n/secrets.json, mode 0600) and never returned. null removes the stored key (BOOF_N8N_API_KEY, when set, still wins).",
    writeOnly: true,
  }),
  rotateWebhookSecret: z.boolean().optional().meta({
    description:
      "Make a new webhook header secret (X-Boof-Token). It is returned once, as `secret`; the first configuration makes one anyway.",
  }),
});

const secretsOf = (ctx: OpContext): N8nSecretStore => ctx.services.n8nSecrets;

/** Without a self check nothing can be told from boof itself, so the n8n operations refuse. */
function selfCheckOf(ctx: OpContext): (url: URL) => boolean {
  if (!ctx.isSelfUrl) {
    throw new OpError(
      500,
      "This surface cannot tell this server's own address, so the n8n operation is refused",
      "internal",
    );
  }
  return ctx.isSelfUrl;
}

const clientOf = (ctx: OpContext): N8nClient =>
  new N8nClient({ root: ctx.root, resolveHost: ctx.resolveHost, isSelfUrl: selfCheckOf(ctx) });

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

async function infoOf(ctx: OpContext, n8n: N8nSettings | undefined): Promise<N8nInfo> {
  const secrets = secretsOf(ctx);
  const apiKeySource = await secrets.apiKeySource();
  const webhookSecretSet = (await secrets.getWebhookSecret()) !== null;
  if (!n8n)
    return { configured: false, apiKeySet: apiKeySource !== null, apiKeySource, webhookSecretSet };
  return {
    configured: true,
    baseUrl: n8n.baseUrl,
    ...(n8n.webhookBaseUrl ? { webhookBaseUrl: n8n.webhookBaseUrl } : {}),
    callbackBaseUrl: n8n.callbackBaseUrl,
    defaultTimeoutMs: n8n.defaultTimeoutMs,
    ...(n8n.checks ? { checks: n8n.checks } : {}),
    apiKeySet: apiKeySource !== null,
    apiKeySource,
    webhookSecretSet,
  };
}

export const n8nGet = defineOp({
  name: "n8n.get",
  title: "Get the n8n connection",
  description:
    "Returns how boof is connected to n8n: the URLs, the timeout, the check settings, and whether an API key and a webhook secret are set. Never returns the key or the secret. { configured: false } when n8n is not set up. No side effects, no call to n8n.",
  scope: "settings:read",
  projectScoped: false,
  input: z.strictObject({}),
  output: N8nInfoSchema,
  rest: { method: "GET", path: "/n8n" },
  mcp: { expose: true, name: "boof_get_n8n", annotations: READ },
  summary: (r) => (r.configured ? `n8n at ${r.baseUrl}` : "n8n is not configured"),
  handler: async (ctx) => infoOf(ctx, (await ctx.services.loadSettings()).n8n),
});

export const n8nUpdate = defineOp({
  name: "n8n.update",
  title: "Configure n8n",
  description:
    "Connects boof to an n8n instance or changes the connection. The first call needs baseUrl and callbackBaseUrl (the address n8n uses to reach boof, proxy prefix included) and returns the webhook header secret once as `secret`. baseUrl and the host of webhookBaseUrl may be on loopback or a LAN when they are the n8n host itself; any other private webhook host must be listed in security.allowedPrivateWebhookHosts. Neither may be this boof server. apiKey is write-only and stored in n8n/secrets.json (mode 0600). rotateWebhookSecret returns a new secret once. checks.projectId must exist. Changing the origin of baseUrl without a new apiKey removes the stored key and the workflow cache (`notice` says so). Needs admin and a trusted, project-unrestricted client: n8n steps send task content to n8n.",
  scope: "admin",
  projectScoped: false,
  input: N8nUpdateInput,
  output: N8nInfoSchema.extend({ secret: z.string().optional(), notice: z.string().optional() }),
  rest: { method: "PUT", path: "/n8n" },
  mcp: { expose: true, name: "boof_update_n8n", annotations: IDEMPOTENT_WRITE },
  summary: () => "Updated the n8n connection",
  audit: (input) => auditExtras(input, false),
  handler: async (ctx, input) => {
    assertMayWriteSettings(ctx);
    const settings = await ctx.services.loadSettings();
    const current = settings.n8n;
    if (!current) {
      for (const field of ["baseUrl", "callbackBaseUrl"] as const) {
        if (input[field] === undefined) {
          throw new OpError(400, `${field} is required to configure n8n`, "invalid_input", [
            { path: field, message: "Required" },
          ]);
        }
      }
    }
    const next = buildNext(current, input);
    if (next.checks) await ctx.services.getProject(next.checks.projectId);
    if (input.baseUrl !== undefined || input.webhookBaseUrl !== undefined) {
      const isSelfUrl = selfCheckOf(ctx);
      const allowed = securitySettings(settings).allowedPrivateWebhookHosts;
      const urls: [string, string][] = [["baseUrl", next.baseUrl]];
      if (next.webhookBaseUrl) urls.push(["webhookBaseUrl", next.webhookBaseUrl]);
      for (const [path, url] of urls) {
        const checked = await checkN8nTarget(url, next, allowed, {
          resolveHost: ctx.resolveHost,
          isSelfUrl,
        });
        if (!checked.ok) {
          const hint =
            path === "webhookBaseUrl" && checked.reason.includes(" is ")
              ? "; list the host in security.allowedPrivateWebhookHosts to allow it"
              : "";
          throw new OpError(
            400,
            `The n8n ${path} is not allowed: ${checked.reason}${hint}`,
            "invalid_input",
            [{ path, message: checked.reason }],
          );
        }
      }
    }
    const secrets = secretsOf(ctx);
    await ctx.services.settingsStore.mutate((s) => ({ ...s, n8n: next }));
    // The key and the secret are written only after the settings write succeeded.
    // A new origin must not receive the key stored for the old one, nor show its workflows.
    const moved = current !== undefined && originOf(current.baseUrl) !== originOf(next.baseUrl);
    let keyCleared = false;
    if (typeof input.apiKey === "string") await secrets.setApiKey(input.apiKey);
    else if (input.apiKey === null) await secrets.deleteApiKey();
    else if (moved) {
      keyCleared = (await secrets.apiKeySource()) === "file";
      await secrets.deleteApiKey();
    }
    if (moved) {
      const paths = dataRootPaths(ctx.root);
      await rm(paths.n8nWorkflows, { force: true });
      await rm(paths.n8nSeen, { force: true });
    }
    let secret: string | undefined;
    if (!current || input.rotateWebhookSecret === true || !(await secrets.getWebhookSecret())) {
      secret = await secrets.rotateWebhookSecret();
    }
    ctx.audit?.({
      ...auditExtras(input, secret !== undefined),
      ...(keyCleared ? { apiKey: "removed" } : {}),
    });
    return {
      ...(await infoOf(ctx, next)),
      ...(secret ? { secret } : {}),
      ...(keyCleared
        ? {
            notice:
              "The n8n address changed, so the stored API key was removed; set a new apiKey for the new address.",
          }
        : {}),
    };
  },
});

function auditExtras(
  input: z.output<typeof N8nUpdateInput>,
  rotated: boolean,
): Record<string, unknown> {
  const fields = Object.keys(input).filter(
    (k) =>
      k !== "apiKey" &&
      k !== "rotateWebhookSecret" &&
      (input as Record<string, unknown>)[k] !== undefined,
  );
  return {
    fields,
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey === null ? "removed" : "set" }),
    ...(rotated || input.rotateWebhookSecret ? { secret: "rotated" } : {}),
  };
}

function buildNext(
  current: N8nSettings | undefined,
  input: z.output<typeof N8nUpdateInput>,
): N8nSettings {
  const merged: Record<string, unknown> = { ...(current ?? {}) };
  for (const key of ["baseUrl", "callbackBaseUrl", "defaultTimeoutMs"] as const) {
    if (input[key] !== undefined) merged[key] = input[key];
  }
  if (input.webhookBaseUrl === null) delete merged.webhookBaseUrl;
  else if (input.webhookBaseUrl !== undefined) merged.webhookBaseUrl = input.webhookBaseUrl;
  if (input.checks === null) delete merged.checks;
  else if (input.checks !== undefined) merged.checks = input.checks;
  return N8nSettingsSchema.parse(merged);
}

export const n8nDelete = defineOp({
  name: "n8n.delete",
  title: "Disconnect n8n",
  description:
    'Removes the n8n connection: settings.n8n, the stored API key and webhook secret, and the workflow cache. Projects keep their externalSteps (those steps then fail with "n8n is not configured"); the answer lists those projects. Needs admin and a trusted, project-unrestricted client.',
  scope: "admin",
  projectScoped: false,
  input: z.strictObject({}),
  output: z.object({ ok: z.literal(true), projectsWithSteps: z.array(z.string()) }),
  rest: { method: "DELETE", path: "/n8n" },
  mcp: { expose: true, name: "boof_delete_n8n", annotations: DESTRUCTIVE },
  summary: (r) => `Removed the n8n connection (${r.projectsWithSteps.length} projects keep steps)`,
  handler: async (ctx) => {
    assertMayWriteSettings(ctx);
    await ctx.services.settingsStore.mutate((s) => {
      const { n8n: _n8n, ...rest } = s;
      return rest as typeof s;
    });
    await secretsOf(ctx).deleteAll();
    const paths = dataRootPaths(ctx.root);
    await rm(paths.n8nWorkflows, { force: true });
    await rm(paths.n8nSeen, { force: true });
    const projects = await ctx.services.listProjects();
    return {
      ok: true as const,
      projectsWithSteps: projects
        .filter((p) => (p.externalSteps ?? []).length > 0)
        .map((p) => p.id),
    };
  },
});

export const n8nWorkflowsList = defineOp({
  name: "n8n.workflows.list",
  title: "List n8n workflows",
  description:
    "Lists the n8n workflows from the last refresh (cache only; no call to n8n). Each has its webhooks (only a single POST webhook is `usable` for a step) and an editor link. { configured: false, workflows: [] } when n8n is not set up; `lastError` shows why the last refresh failed.",
  scope: "settings:read",
  projectScoped: false,
  input: z.strictObject({}),
  output: WorkflowsResultSchema,
  rest: { method: "GET", path: "/n8n/workflows" },
  mcp: { expose: true, name: "boof_list_n8n_workflows", annotations: READ },
  summary: (r) => `${r.workflows.length} n8n workflows`,
  handler: async (ctx) => {
    if (!(await ctx.services.loadSettings()).n8n) {
      return { configured: false, fetchedAt: null, workflows: [] };
    }
    return { configured: true, ...(await readWorkflowCache(ctx.root)) };
  },
});

export const n8nWorkflowsRefresh = defineOp({
  name: "n8n.workflows.refresh",
  title: "Refresh the n8n workflow list",
  description:
    "Fetches the workflow list from n8n (its public API, with the stored API key) and rewrites the cache. 409 n8n_not_configured when n8n is not set up; 502 upstream_failed with details.reason (unauthorized, unreachable, blocked, redirected, bad_response, too_many, HTTP <n>) when n8n cannot be read, and the cached list stays.",
  scope: "settings:write",
  projectScoped: false,
  input: z.strictObject({}),
  output: WorkflowsResultSchema,
  rest: { method: "POST", path: "/n8n/workflows/refresh" },
  mcp: { expose: true, name: "boof_refresh_n8n_workflows", annotations: IDEMPOTENT_WRITE },
  summary: (r) => `Refreshed: ${r.workflows.length} n8n workflows`,
  handler: async (ctx) => {
    if (!(await ctx.services.loadSettings()).n8n) {
      throw new OpError(409, "n8n is not configured", "n8n_not_configured");
    }
    return { configured: true, ...(await clientOf(ctx).refresh()) };
  },
});

export const n8nOps = [n8nGet, n8nUpdate, n8nDelete, n8nWorkflowsList, n8nWorkflowsRefresh];
