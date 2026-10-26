import { randomBytes } from "node:crypto";
import { z } from "zod";
import { EVENT_TYPES, type Webhook } from "@boof-runner/shared";
import { defineOp } from "../define-op.js";
import { OpError } from "../errors.js";
import { PublicWebhookSchema, OkSchema } from "../schemas.js";
import { CreateWebhookBody } from "../validation.js";
import { DESTRUCTIVE, webhookIdParam, WRITE, READ } from "./common.js";

const publicWebhook = ({ secret: _s, ...rest }: Webhook) => rest;

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

export const webhooksList = defineOp({
  name: "webhooks.list",
  title: "List webhooks",
  description: "Lists the webhook subscriptions without their secrets. No input. Admin only.",
  scope: "admin",
  projectScoped: false,
  input: z.strictObject({}),
  output: z.object({ webhooks: z.array(PublicWebhookSchema) }),
  rest: { method: "GET", path: "/webhooks" },
  mcp: { expose: false, annotations: READ },
  handler: async (ctx) => ({
    webhooks: ((await ctx.services.loadSettings()).webhooks ?? []).map(publicWebhook),
  }),
});

export const webhooksCreate = defineOp({
  name: "webhooks.create",
  title: "Create a webhook",
  description:
    "Subscribes a URL to events and returns the signing secret once. Inputs: url (http or https), optional events (types or prefix.*), projects, enabled. Admin only; stores the secret in settings.json.",
  scope: "admin",
  projectScoped: false,
  input: CreateWebhookBody,
  output: z.object({ webhook: PublicWebhookSchema, secret: z.string() }),
  rest: { method: "POST", path: "/webhooks", status: 201 },
  mcp: { expose: false, annotations: WRITE },
  handler: async (ctx, input) => {
    assertWebhookUrl(input.url, ctx.isSelfUrl);
    const events = input.events ?? ["*"];
    for (const pattern of events) {
      if (!EVENT_TYPES.some((t) => eventMatches(pattern, t))) {
        throw new OpError(400, `Unknown event type: ${pattern}`, "invalid_input", [
          { path: "events", message: `Unknown event type: ${pattern}` },
        ]);
      }
    }
    const webhook: Webhook = {
      id: `wh-${randomBytes(4).toString("hex")}`,
      url: input.url,
      secret: `whsec_${randomBytes(24).toString("hex")}`,
      events,
      projects: input.projects ?? "*",
      enabled: input.enabled ?? true,
      createdBy: ctx.principal.id,
      created: ctx.now(),
    };
    const settings = await ctx.services.loadSettings();
    await ctx.services.settingsStore.save({
      ...settings,
      webhooks: [...(settings.webhooks ?? []), webhook],
    });
    return { webhook: publicWebhook(webhook), secret: webhook.secret };
  },
});

export const webhooksDelete = defineOp({
  name: "webhooks.delete",
  title: "Delete a webhook",
  description:
    "Removes a webhook subscription. Input: webhookId. Admin only; undelivered retries are dropped.",
  scope: "admin",
  projectScoped: false,
  input: z.strictObject({ webhookId: webhookIdParam }),
  output: OkSchema,
  rest: { method: "DELETE", path: "/webhooks/{webhookId}" },
  mcp: { expose: false, annotations: DESTRUCTIVE },
  handler: async (ctx, input) => {
    const settings = await ctx.services.loadSettings();
    const hooks = settings.webhooks ?? [];
    if (!hooks.some((h) => h.id === input.webhookId)) throw new OpError(404, "Webhook not found");
    await ctx.services.settingsStore.save({
      ...settings,
      webhooks: hooks.filter((h) => h.id !== input.webhookId),
    });
    return { ok: true as const };
  },
});

export const webhookOps = [webhooksList, webhooksCreate, webhooksDelete];
