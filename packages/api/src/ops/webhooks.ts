import { randomBytes } from "node:crypto";
import { z } from "zod";
import { EVENT_TYPES, securitySettings, type Webhook } from "@boof-runner/shared";
import { defineOp, type OpContext } from "../define-op.js";
import { OpError } from "../errors.js";
import { assertWebhookTarget } from "../net-guard.js";
import { PublicWebhookSchema, OkSchema } from "../schemas.js";
import { CreateWebhookBody } from "../validation.js";
import { DESTRUCTIVE, webhookIdParam, WRITE, READ } from "./common.js";

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
  handler: async (ctx) => ({
    webhooks: ((await ctx.services.loadSettings()).webhooks ?? [])
      .filter((h) => withinReach(ctx, h))
      .map((h) => ({ ...h, url: redactUrl(h.url) })),
  }),
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
    // A project-restricted key cannot subscribe to events of projects it may not access: the
    // default is its own projects, and a wider list is refused.
    const mine = ctx.principal.projects;
    let projects: "*" | string[] = input.projects ?? "*";
    if (mine !== "*") {
      if (input.projects === undefined) projects = [...mine];
      else {
        const outside = input.projects === "*" ? ["*"] : input.projects.filter((p) => !mine.has(p));
        if (outside.length > 0) {
          throw new OpError(
            403,
            "Webhook reaches projects you may not access",
            "forbidden_project",
            {
              projects: outside,
            },
          );
        }
      }
    }
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

export const webhookOps = [webhooksList, webhooksCreate, webhooksDelete];
