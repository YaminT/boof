import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConciergeStore, conciergeDir, conciergeSettings } from "@boof/heart";
import { promptFingerprint } from "../audit.js";
import { defineOp, type OpContext } from "../define-op.js";
import {
  ConciergeAnswerSchema,
  ConciergeChangeSchema,
  ConciergeStatusSchema,
  OkSchema,
} from "../schemas.js";
import { projectIdParam } from "./common.js";

const changeIdParam = z.string().regex(/^chg-[a-f0-9]{8}$/);
const context = z.strictObject({
  screen: z.enum(["overview", "tasks", "task", "plans", "settings", "inbox"]),
  taskId: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  planId: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  goalId: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
});
export const ConciergeAskInputSchema = z.strictObject({
  projectId: projectIdParam,
  text: z.string().trim().min(1).max(4000),
  context: context.optional(),
  conversationId: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
});

const restOnly = {
  expose: false,
  why: "The assistant is itself a model: an MCP host driving it would spend budget model-to-model and could confirm its own proposals. The operations it uses are MCP tools.",
} as const;

async function readConciergeStatus(ctx: OpContext, projectId: string) {
  const project = await ctx.services.getProject(projectId);
  const settings = await ctx.services.loadSettings();
  const config = conciergeSettings(settings);
  let availability: Pick<z.output<typeof ConciergeStatusSchema>, "available" | "reason" | "via"> = {
    available: false,
    reason: "The assistant is not set up in this boof process.",
    via: null as "gateway" | "project-key" | null,
  };
  if (!config.enabled) {
    availability = {
      available: false,
      reason: "The assistant is turned off (settings.concierge.enabled is false).",
      via: null,
    };
  } else if (ctx.services.conciergeAgent) {
    availability = await ctx.services.conciergeAgent.availability(project);
  }

  // A status GET is read-only: look up an existing live conversation without asking the
  // ConciergeStore to create one as `current()` does.
  let conversation: z.output<typeof ConciergeStatusSchema>["conversation"] = null;
  try {
    const live = JSON.parse(
      await readFile(join(conciergeDir(ctx.root, projectId), "live.json"), "utf8"),
    ) as {
      owners?: Record<string, string>;
    };
    const id = live.owners?.[ctx.principal.id];
    if (id) {
      const found = await new ConciergeStore(ctx.root).get(projectId, id);
      if (
        found &&
        found.owner === ctx.principal.id &&
        Date.parse(found.updatedAt) + config.idleMinutes * 60_000 > Date.now()
      ) {
        conversation = {
          id: found.id,
          spentUsd: found.spentUsd,
          messages: found.messages,
          pending: found.changes
            .filter(
              (change) => change.status === "pending" && Date.parse(change.expiresAt) > Date.now(),
            )
            .map(
              ({ id: changeId, op, title, details, destructive, reason, status, expiresAt }) => ({
                id: changeId,
                op,
                title,
                details,
                destructive,
                reason,
                status,
                expiresAt,
              }),
            ),
        };
      }
    }
  } catch {
    // No live index, or a broken index: status remains useful without a conversation summary.
  }
  return {
    ...availability,
    model: config.model,
    limits: {
      perMessageUsd: config.perMessageUsd,
      perConversationUsd: config.perConversationUsd,
      messagesPerMinute: config.messagesPerMinute,
    },
    conversation,
  };
}

export const conciergeOps = [
  defineOp({
    name: "concierge.status",
    title: "Get assistant status",
    description:
      "Gets assistant availability and the current conversation for a project. Inputs: projectId. No side effects.",
    scope: "tasks:read",
    projectScoped: true,
    input: z.strictObject({ projectId: projectIdParam }),
    output: ConciergeStatusSchema,
    rest: { method: "GET", path: "/projects/{projectId}/concierge" },
    mcp: restOnly,
    handler: async (ctx, { projectId }) => readConciergeStatus(ctx, projectId),
  }),
  defineOp({
    name: "concierge.ask",
    title: "Ask the assistant",
    description:
      "Sends a message to the assistant for the selected project. Inputs: projectId, text and optional page context or conversationId. May create drafts and pending changes, and records model spend.",
    scope: "tasks:read",
    projectScoped: true,
    input: ConciergeAskInputSchema,
    output: ConciergeAnswerSchema,
    rest: { method: "POST", path: "/projects/{projectId}/concierge/messages" },
    mcp: restOnly,
    audit: (input) => promptFingerprint(input.text),
    handler: async (ctx, { projectId, text, context: pageContext, conversationId }) =>
      ctx.services
        .concierge()
        .ask(
          ctx.principal,
          projectId,
          { text, context: pageContext, conversationId },
          undefined,
          ctx.signal,
        ),
  }),
  defineOp({
    name: "concierge.apply",
    title: "Apply an assistant change",
    description:
      "Applies a pending assistant change with the caller's own rights. Inputs: projectId and changeId. Changes one project item once.",
    scope: "tasks:read",
    projectScoped: true,
    input: z.strictObject({ projectId: projectIdParam, changeId: changeIdParam }),
    output: z.object({ change: ConciergeChangeSchema, result: z.unknown() }),
    rest: { method: "POST", path: "/projects/{projectId}/concierge/changes/{changeId}/apply" },
    mcp: restOnly,
    handler: async (ctx, { projectId, changeId }) =>
      ctx.services.concierge().apply(ctx.principal, projectId, changeId),
  }),
  defineOp({
    name: "concierge.discard",
    title: "Discard an assistant change",
    description:
      "Discards a pending assistant change. Inputs: projectId and changeId. The proposed change is not applied.",
    scope: "tasks:read",
    projectScoped: true,
    input: z.strictObject({ projectId: projectIdParam, changeId: changeIdParam }),
    output: z.object({ change: ConciergeChangeSchema }),
    rest: { method: "POST", path: "/projects/{projectId}/concierge/changes/{changeId}/discard" },
    mcp: restOnly,
    handler: async (ctx, { projectId, changeId }) => ({
      change: await ctx.services.concierge().discard(ctx.principal, projectId, changeId),
    }),
  }),
  defineOp({
    name: "concierge.reset",
    title: "Reset assistant conversation",
    description:
      "Ends the caller's current assistant conversation for a project. Inputs: projectId. Pending changes remain available until discarded or expired.",
    scope: "tasks:read",
    projectScoped: true,
    input: z.strictObject({ projectId: projectIdParam }),
    output: OkSchema,
    rest: { method: "POST", path: "/projects/{projectId}/concierge/reset" },
    mcp: restOnly,
    handler: async (ctx, { projectId }) => {
      await ctx.services.concierge().reset(ctx.principal, projectId);
      return { ok: true as const };
    },
  }),
];
