import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  EVENT_TYPES,
  isExpired,
  securitySettings,
  type Client,
  type Webhook,
} from "@boof-runner/shared";
import { defineOp, type OpContext } from "../define-op.js";
import { OpError } from "../errors.js";
import { assertWebhookTarget } from "../net-guard.js";
import { PublicWebhookSchema, OkSchema } from "../schemas.js";
import { CreateWebhookBody, UpdateWebhookFields } from "../validation.js";
import { DESTRUCTIVE, IDEMPOTENT_WRITE, webhookIdParam, WRITE, READ } from "./common.js";

/** True when `pattern` (`*`, `plan.*` or an exact type) selects event type `type`. */
export function eventMatches(pattern: string, type: string): boolean {
  return (
    pattern === "*" ||
    pattern === type ||
    (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1)))
  );
}

/** Webhook URLs must be http(s) and must not point back at the boof server. */
export function assertWebhookUrl(raw: string, isSelf?: (url: URL) => boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OpError(400, "The webhook URL is not a valid URL", "invalid_input", [
      { path: "url", message: "Invalid URL" },
    ]);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OpError(400, "The webhook URL must be http or https", "invalid_input", [
      { path: "url", message: "Must be http(s)" },
    ]);
  }
  if (isSelf?.(url)) {
    throw new OpError(400, "The webhook URL points at this boof server", "invalid_input", [
      { path: "url", message: "Must not be the boof server itself" },
    ]);
  }
  return url;
}

/**
 * `scheme://host/…`: Slack, Discord and similar webhook URLs carry a secret in the path or query,
 * so only the full address given at create time (and used for delivery) holds it. Lists and
 * summaries show the host.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return "(invalid URL)";
  }
}

/**
 * Why a webhook made by an API client is not delivered: the client is revoked, expired or gone, or
 * no longer covers the webhook's projects. Null when it is delivered. Webhooks of the local
 * principal, and older ones whose creator is not a known client, are never a problem. `clients`
 * undefined (no client list) checks nothing.
 */
export function creatorProblem(
  hook: Webhook,
  clients: readonly Client[] | undefined,
  nowMs: number,
): string | null {
  // `local` is the local principal; it is never looked up as a client.
  if (!clients || hook.createdBy === "local") return null;
  const creator = clients.find((c) => c.id === hook.createdBy);
  if (!hook.createdByClient && !creator) return null;
  if (!creator) return `creator ${hook.createdBy} no longer exists`;
  if (creator.revokedAt) return `creator ${creator.name} is revoked`;
  if (isExpired(creator, nowMs)) return `creator ${creator.name} has expired`;
  if (creator.projects === "*") return null;
  if (hook.projects === "*" || !hook.projects.every((p) => creator.projects.includes(p)))
    return `creator ${creator.name} cannot reach its projects`;
  return null;
}

/** True when the caller's projects cover everything the webhook reaches (same rule as client management). */
function withinReach(ctx: OpContext, hook: Webhook): boolean {
  const mine = ctx.principal.projects;
  if (mine === "*") return true;
  return hook.projects !== "*" && hook.projects.every((p) => mine.has(p));
}

export const webhooksList = defineOp({
  name: "webhooks.list",
  title: "List webhooks",
  description:
    "Lists the webhook subscriptions without their secrets; each URL is shown as scheme://host/… (the full address is shown once, at create). No input. Admin only; a project-restricted key sees only the webhooks that reach its projects alone.",
  scope: "admin",
  projectScoped: false,
  input: z.strictObject({}),
  output: z.object({ webhooks: z.array(PublicWebhookSchema) }),
  rest: { method: "GET", path: "/webhooks" },
  mcp: { expose: true, name: "boof_list_webhooks", annotations: READ },
  summary: (r) => `${r.webhooks.length} webhooks`,
  handler: async (ctx) => {
    const clients = await ctx.authStore.list();
    const now = Date.now();
    return {
      webhooks: ((await ctx.services.loadSettings()).webhooks ?? [])
        .filter((h) => withinReach(ctx, h))
        .map((h) => {
          const problem = h.enabled ? creatorProblem(h, clients, now) : null;
          return { ...h, url: redactUrl(h.url), ...(problem ? { notDelivering: problem } : {}) };
        }),
    };
  },
});

export const webhooksCreate = defineOp({
  name: "webhooks.create",
  title: "Create a webhook",
  description:
    "Subscribes a URL to events and returns the signing secret once. Inputs: url (http or https; must resolve to a public address unless listed in security.allowedPrivateWebhookHosts), optional events (types or prefix.*), projects, enabled. Admin only; the secret is kept in <data>/webhooks/secrets.json (mode 0600), never in settings.json.",
  scope: "admin",
  projectScoped: false,
  input: CreateWebhookBody,
  output: z.object({ webhook: PublicWebhookSchema, secret: z.string() }),
  rest: { method: "POST", path: "/webhooks", status: 201 },
  mcp: { expose: true, name: "boof_create_webhook", annotations: WRITE },
  summary: (r) =>
    `Subscribed webhook ${r.webhook.id} to ${redactUrl(r.webhook.url)}; the signing secret is in the result and is shown only once`,
  handler: async (ctx, input) => {
    await assertWebhookTarget(input.url, {
      isSelf: ctx.isSelfUrl,
      resolve: ctx.resolveHost,
      allowedPrivateHosts: securitySettings(await ctx.services.loadSettings())
        .allowedPrivateWebhookHosts,
    });
    const events = input.events ?? ["*"];
    for (const pattern of events) {
      if (!EVENT_TYPES.some((t) => eventMatches(pattern, t))) {
        throw new OpError(400, `Unknown event type: ${pattern}`, "invalid_input", [
          { path: "events", message: `Unknown event type: ${pattern}` },
        ]);
      }
    }
    // The default for a project-restricted key is its own projects.
    const mine = ctx.principal.projects;
    const checked = reachableProjects(ctx, input.projects);
    const projects: "*" | string[] = checked ?? (mine === "*" ? "*" : [...mine]);
    const webhook: Webhook = {
      id: `wh-${randomBytes(4).toString("hex")}`,
      url: input.url,
      events,
      projects,
      enabled: input.enabled ?? true,
      createdBy: ctx.principal.id,
      ...(ctx.principal.kind === "client" ? { createdByClient: true } : {}),
      created: ctx.now(),
    };
    const secret = `whsec_${randomBytes(24).toString("hex")}`;
    await ctx.services.webhookSecrets.set(webhook.id, secret);
    await ctx.services.settingsStore.mutate((settings) => ({
      ...settings,
      webhooks: [...(settings.webhooks ?? []), webhook],
    }));
    return { webhook, secret };
  },
});

/**
 * A project-restricted key cannot subscribe to events of projects it may not access: a wider list
 * is refused. Shared by create and update; `undefined` means the caller did not ask for any.
 */
function reachableProjects(
  ctx: OpContext,
  requested: "*" | string[] | undefined,
): "*" | string[] | undefined {
  const mine = ctx.principal.projects;
  if (mine === "*" || requested === undefined) return requested;
  const outside = requested === "*" ? ["*"] : requested.filter((p) => !mine.has(p));
  if (outside.length > 0) {
    throw new OpError(403, "Webhook reaches projects you may not access", "forbidden_project", {
      projects: outside,
    });
  }
  return requested;
}

export const webhooksUpdate = defineOp({
  name: "webhooks.update",
  title: "Update a webhook",
  description:
    'Enables, disables or edits a webhook without recreating it: its signing secret and id stay, and the secret is never returned. Inputs: webhookId plus at least one of url, events, projects, enabled. The URL goes through the same guard as on create, events must be known types or prefix.* patterns, and projects is "*" or a non-empty list. Admin only; a project-restricted key may change only a webhook that reaches its projects alone (others answer 404) and not widen it, and a review-trust key only one it created (403). The creator cannot be changed. A webhook made by a project-restricted client cannot be widened beyond that client\'s projects (403). Disabling stops delivery: events that happen while it is disabled are skipped and queued retries are dropped, so enabling it again starts fresh. Changing the URL, events or projects drops queued retries that no longer fit. The list shows `notDelivering` for an enabled webhook whose creator is revoked, expired, gone or out of reach. The answer shows the URL as scheme://host/… only.',
  scope: "admin",
  projectScoped: false,
  input: z
    .strictObject({ webhookId: webhookIdParam, ...UpdateWebhookFields.shape })
    .refine((v) => Object.keys(v).length > 1, { message: "Send at least one field to change" }),
  output: PublicWebhookSchema,
  rest: { method: "PUT", path: "/webhooks/{webhookId}" },
  mcp: { expose: true, name: "boof_update_webhook", annotations: IDEMPOTENT_WRITE },
  summary: (w) => `Updated webhook ${w.id}`,
  handler: async (ctx, { webhookId, ...patch }) => {
    // The URL is vetted before anything is written, exactly as on create.
    if (patch.url !== undefined) {
      await assertWebhookTarget(patch.url, {
        isSelf: ctx.isSelfUrl,
        resolve: ctx.resolveHost,
        allowedPrivateHosts: securitySettings(await ctx.services.loadSettings())
          .allowedPrivateWebhookHosts,
      });
    }
    for (const pattern of patch.events ?? []) {
      if (!EVENT_TYPES.some((t) => eventMatches(pattern, t))) {
        throw new OpError(400, `Unknown event type: ${pattern}`, "invalid_input", [
          { path: "events", message: `Unknown event type: ${pattern}` },
        ]);
      }
    }
    const projects = reachableProjects(ctx, patch.projects);
    const clients = await ctx.authStore.list();
    let updated!: Webhook;
    await ctx.services.settingsStore.mutate((settings) => {
      const hooks = settings.webhooks ?? [];
      const hook = hooks.find((h) => h.id === webhookId);
      // A webhook beyond the caller's reach answers like an unknown one.
      if (!hook || !withinReach(ctx, hook)) throw new OpError(404, "Webhook not found");
      // A review-trust key changes only the webhooks it created.
      if (ctx.principal.trust === "review" && hook.createdBy !== ctx.principal.id) {
        throw new OpError(
          403,
          "This client has review trust and can only change webhooks it created",
          "forbidden_trust",
        );
      }
      // The creator's reach limits the webhook too: delivery stops for one that outgrows it.
      if (projects !== undefined && hook.createdBy !== "local") {
        const creator = clients.find((c) => c.id === hook.createdBy);
        if (creator && creator.projects !== "*") {
          const outside =
            projects === "*" ? ["*"] : projects.filter((p) => !creator.projects.includes(p));
          if (outside.length > 0) {
            throw new OpError(
              403,
              `This webhook was created by ${creator.name}, whose key cannot reach ${outside.join(", ")}`,
              "forbidden_project",
              { projects: outside },
            );
          }
        }
      }
      // Only these four fields change; id, createdBy, createdByClient and created stay.
      updated = {
        ...hook,
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        ...(patch.events !== undefined ? { events: patch.events } : {}),
        ...(projects !== undefined ? { projects } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      };
      return { ...settings, webhooks: hooks.map((h) => (h.id === webhookId ? updated : h)) };
    });
    // Like the list, the answer shows the address as scheme://host/… only.
    return { ...updated, url: redactUrl(updated.url) };
  },
});

export const webhooksDelete = defineOp({
  name: "webhooks.delete",
  title: "Delete a webhook",
  description:
    "Removes a webhook subscription. Input: webhookId. Admin only; undelivered retries are dropped. A project-restricted key may remove only a webhook that reaches its projects alone (others answer 404), and a review-trust key only one it created (403).",
  scope: "admin",
  projectScoped: false,
  input: z.strictObject({ webhookId: webhookIdParam }),
  output: OkSchema,
  rest: { method: "DELETE", path: "/webhooks/{webhookId}" },
  mcp: { expose: true, name: "boof_delete_webhook", annotations: DESTRUCTIVE },
  summary: () => "Deleted webhook",
  handler: async (ctx, input) => {
    await ctx.services.settingsStore.mutate((settings) => {
      const hooks = settings.webhooks ?? [];
      // A webhook beyond the caller's reach answers like an unknown one.
      const hook = hooks.find((h) => h.id === input.webhookId);
      if (!hook || !withinReach(ctx, hook)) throw new OpError(404, "Webhook not found");
      // A review-trust key removes only the webhooks it created.
      if (ctx.principal.trust === "review" && hook.createdBy !== ctx.principal.id) {
        throw new OpError(
          403,
          "This client has review trust and can only delete webhooks it created",
          "forbidden_trust",
        );
      }
      return { ...settings, webhooks: hooks.filter((h) => h.id !== input.webhookId) };
    });
    await ctx.services.webhookSecrets.delete(input.webhookId);
    return { ok: true as const };
  },
});

export const webhookOps = [webhooksList, webhooksCreate, webhooksUpdate, webhooksDelete];
