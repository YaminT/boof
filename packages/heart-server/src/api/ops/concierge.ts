import { z } from "zod";
import { promptFingerprint } from "../audit.js";
import { defineOp } from "../define-op.js";
import {
  ConciergeAnswerSchema,
  ConciergeChangeSchema,
  ConciergeStatusSchema,
  OkSchema,
} from "../schemas.js";
import { projectIdParam } from "./common.js";
import { ConciergeContextSchema } from "../../concierge/service.js";

const changeIdParam = z.string().regex(/^chg-[a-f0-9]{8}$/);
export const ConciergeAskInputSchema = z.strictObject({
  projectId: projectIdParam,
  text: z.string().trim().min(1).max(4000),
  context: ConciergeContextSchema.optional(),
  conversationId: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
});

const restOnly = {
  expose: false,
  why: "The assistant is itself a model: an MCP host driving it would spend budget model-to-model and could confirm its own proposals. The operations it uses are MCP tools.",
} as const;

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
    handler: async (ctx, { projectId }) =>
      ctx.services.concierge().status(ctx.principal, projectId),
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
