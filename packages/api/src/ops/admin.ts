import { z } from "zod";
import {
  authorizeProject,
  hasScope,
  parseDuration,
  SettingsPatchSchema,
  TokenUsageSchema,
} from "@boof-runner/shared";
import { defineOp } from "../define-op.js";
import { OpError } from "../errors.js";
import { buildModelDetails } from "../services/model-details.js";
import { CommandBody, CreateClientBody } from "../validation.js";
import {
  CommandTemplateSchema,
  HealthResultSchema,
  ModelDetailsSchema,
  PublicClientSchema,
  BudgetExceededListSchema,
  BudgetStatusSchema,
  PublicSettingsSchema,
  TaskViewSchema,
} from "../schemas.js";
import {
  clientIdParam,
  commandIdParam,
  IDEMPOTENT_WRITE,
  READ,
  WRITE,
  DESTRUCTIVE,
} from "./common.js";

/** Settings without the webhook list (secrets): see the webhooks operations. */
export function publicSettings<T extends { webhooks?: unknown }>(s: T): Omit<T, "webhooks"> {
  const { webhooks: _w, ...rest } = s;
  return rest;
}

export const settingsGet = defineOp({
  name: "settings.get",
  title: "Get settings",
  description:
    "Returns the global settings (runner, roles, review, security, models). No side effects.",
  scope: "settings:read",
  projectScoped: false,
  input: z.strictObject({}),
  output: PublicSettingsSchema,
  rest: { method: "GET", path: "/settings" },
  mcp: { expose: false, name: "boof_get_settings", annotations: READ },
  summary: (s) =>
    `Runner ${s.runner.enabled ? "enabled" : "disabled"}, default project ${s.defaultProject ?? "none"}`,
  handler: async (ctx) => publicSettings(await ctx.services.loadSettings()),
});

export const settingsUpdate = defineOp({
  name: "settings.update",
  title: "Update settings",
  description:
    "Changes global settings. Input: the fields to change (runner, defaultProject, roles, review, worktree, retries, budget, models). Rewrites settings.json.",
  scope: "settings:write",
  projectScoped: false,
  input: SettingsPatchSchema,
  output: PublicSettingsSchema,
  rest: { method: "PUT", path: "/settings" },
  mcp: { expose: false, name: "boof_update_settings", annotations: IDEMPOTENT_WRITE },
  handler: async (ctx, input) =>
    publicSettings(await ctx.services.updateSettings(input, ctx.principal)),
});

export const settingsHealth = defineOp({
  name: "settings.health",
  title: "Tool health",
  description:
    "Checks that each agent tool (claude-code, codex, opencode) is installed and usable. No input. Runs version probes.",
  scope: "settings:read",
  projectScoped: false,
  input: z.strictObject({}),
  output: z.object({ tools: z.record(z.string(), HealthResultSchema) }),
  rest: { method: "GET", path: "/health" },
  mcp: { expose: false, name: "boof_get_health", annotations: READ },
  summary: (r) =>
    Object.entries(r.tools)
      .map(([k, v]) => `${k}: ${v.status}`)
      .join(", "),
  handler: async (ctx) => ({ tools: await ctx.services.health() }),
});

export const settingsModels = defineOp({
  name: "settings.models",
  title: "List models",
  description: "Lists the models each tool offers. No input. Queries the tools.",
  scope: "settings:read",
  projectScoped: false,
  input: z.strictObject({}),
  output: z.object({ models: z.record(z.string(), z.array(z.string())) }),
  rest: { method: "GET", path: "/models" },
  mcp: { expose: false, name: "boof_list_models", annotations: READ },
  summary: (r) => Object.keys(r.models).join(", "),
  handler: async (ctx) => ({ models: await ctx.services.listModels() }),
});

export const settingsModelDetails = defineOp({
  name: "models.details",
  title: "Model details",
  description:
    "Lists each tool's models with their source (live CLI list, built-in default or settings), whether each is the default, the roles that use it, and the last health result of this server process (null if none ran). No input. Lists models only; runs no health probe or smoke prompt.",
  scope: "settings:read",
  projectScoped: false,
  input: z.strictObject({}),
  output: ModelDetailsSchema,
  rest: { method: "GET", path: "/models/details" },
  mcp: { expose: false },
  summary: (r) =>
    Object.entries(r.tools)
      .map(([k, v]) => `${k}: ${v.models.length} model(s)`)
      .join(", "),
  handler: async (ctx) => {
    const settings = await ctx.services.loadSettings();
    const projects = (await ctx.services.listProjects()).filter((p) =>
      authorizeProject(ctx.principal, p.id),
    );
    const { registry } = ctx.services;
    return {
      tools: buildModelDetails({
        tools: registry.list(),
        live: await registry.liveModels(),
        settings,
        projects,
        health: registry.lastHealth(),
      }),
    };
  },
});

export const usageGlobal = defineOp({
  name: "usage.global",
  title: "Total token usage",
  description:
    "Returns the token usage and cost summed over the projects the client may access. No input.",
  scope: ["projects:read", "tasks:read"],
  projectScoped: false,
  input: z.strictObject({}),
  output: TokenUsageSchema,
  rest: { method: "GET", path: "/usage" },
  mcp: { expose: false, name: "boof_get_usage", annotations: READ },
  summary: (u) => `${u.inputTokens} in / ${u.outputTokens} out tokens, $${u.costUsd.toFixed(2)}`,
  handler: (ctx) => ctx.services.totalUsage((pid) => authorizeProject(ctx.principal, pid)),
});

export const usageBudget = defineOp({
  name: "usage.budget",
  title: "Budget status",
  description:
    "Returns the configured budget limits, today's spend per scope (global, per project, per tool), what remains, which budgets are spent and when they reset. Steps with unknown cost count as 0 (see unknownSteps). No input. No side effects.",
  scope: ["settings:read", "tasks:read"],
  projectScoped: false,
  input: z.strictObject({}),
  output: BudgetStatusSchema,
  rest: { method: "GET", path: "/usage/budget" },
  mcp: { expose: false, name: "boof_get_budget", annotations: READ },
  summary: (b) =>
    b.exceeded.length > 0
      ? `Budget spent: ${b.exceeded.map((e) => e.scope).join(", ")}; resets ${b.resetsAt}`
      : `Within budget on ${b.date} (${b.timezone})`,
  handler: (ctx) => ctx.services.budgetStatus((pid) => authorizeProject(ctx.principal, pid)),
});

export const runnerStatus = defineOp({
  name: "runner.status",
  title: "Runner status",
  description:
    "Returns whether the runner is enabled and its concurrency. No input. No side effects.",
  scope: "settings:read",
  projectScoped: false,
  input: z.strictObject({}),
  output: z.object({
    enabled: z.boolean(),
    concurrency: z.number().int(),
    /** Day budgets that are spent today: the runner does not start work in these scopes. */
    budgetExceeded: BudgetExceededListSchema,
  }),
  rest: { method: "GET", path: "/runner" },
  mcp: { expose: false, name: "boof_get_runner", annotations: READ },
  summary: (r) => `Runner ${r.enabled ? "enabled" : "disabled"} (concurrency ${r.concurrency})`,
  handler: async (ctx) => {
    const { runner } = await ctx.services.loadSettings();
    const budget = await ctx.services.budgetStatus((pid) => authorizeProject(ctx.principal, pid));
    return {
      enabled: runner.enabled,
      concurrency: runner.concurrency,
      budgetExceeded: budget.exceeded,
    };
  },
});

export const runnerOverview = defineOp({
  name: "runner.overview",
  title: "Runner and queue status",
  description:
    "Returns whether the runner is enabled and, per project the client may access, whether it is paused, which tasks run now and how many tasks have each status. No input. No side effects.",
  scope: "settings:read",
  projectScoped: false,
  input: z.strictObject({}),
  output: z.object({
    enabled: z.boolean(),
    concurrency: z.number().int(),
    /** Day budgets that are spent today: the runner does not start work in these scopes. */
    budgetExceeded: BudgetExceededListSchema,
    projects: z.array(
      z.object({
        id: z.string(),
        paused: z.boolean(),
        running: z.array(z.string()),
        counts: z.record(z.string(), z.number().int()),
      }),
    ),
  }),
  rest: { method: "GET", path: "/runner/status" },
  mcp: { expose: true, name: "boof_runner_status", annotations: READ },
  summary: (r) =>
    `Runner ${r.enabled ? "enabled" : "disabled"}` +
    (r.budgetExceeded.length > 0
      ? ` (budget spent: ${r.budgetExceeded.map((b) => b.scope).join(", ")})`
      : "") +
    "; " +
    (r.projects
      .map((p) => `${p.id}${p.paused ? " (paused)" : ""}: ${p.running.length} running`)
      .join(", ") || "no projects"),
  handler: async (ctx) => {
    const { runner } = await ctx.services.loadSettings();
    const projects = [];
    for (const p of await ctx.services.listProjects()) {
      if (!authorizeProject(ctx.principal, p.id)) continue;
      const tasks = await ctx.services.forProject(p.id).list();
      const counts: Record<string, number> = {};
      for (const t of tasks) counts[t.frontmatter.status] = (counts[t.frontmatter.status] ?? 0) + 1;
      projects.push({
        id: p.id,
        paused: p.paused,
        running: tasks
          .filter((t) => t.frontmatter.status === "running")
          .map((t) => t.frontmatter.id),
        counts,
      });
    }
    const budget = await ctx.services.budgetStatus((pid) => authorizeProject(ctx.principal, pid));
    return {
      enabled: runner.enabled,
      concurrency: runner.concurrency,
      budgetExceeded: budget.exceeded,
      projects,
    };
  },
});

export const runnerSetEnabled = defineOp({
  name: "runner.setEnabled",
  title: "Start or pause the runner",
  description:
    "Turns the runner on or off for every project. Input: enabled. Writes settings.json and appends a runner.enabled event.",
  scope: ["runner:control", "settings:write"],
  projectScoped: false,
  input: z.strictObject({ enabled: z.boolean() }),
  output: z.object({ enabled: z.boolean(), concurrency: z.number().int() }),
  rest: { method: "PUT", path: "/runner" },
  mcp: { expose: true, name: "boof_set_runner", annotations: IDEMPOTENT_WRITE },
  summary: (r) => `Runner ${r.enabled ? "enabled" : "disabled"}`,
  handler: async (ctx, input) => {
    const { runner } = await ctx.services.updateSettings(
      { runner: { enabled: input.enabled } },
      ctx.principal,
    );
    return { enabled: runner.enabled, concurrency: runner.concurrency };
  },
});

export const actionsList = defineOp({
  name: "actions.list",
  title: "List tasks needing an answer",
  description:
    "Lists tasks parked with questions across the projects the client may access. No input. No side effects.",
  scope: "tasks:read",
  projectScoped: false,
  input: z.strictObject({}),
  output: z.object({ actions: z.array(TaskViewSchema) }),
  rest: { method: "GET", path: "/actions" },
  mcp: { expose: true, name: "boof_list_actions", annotations: READ },
  summary: (r) => `${r.actions.length} task(s) waiting for answers`,
  handler: async (ctx) => {
    const all = await ctx.services.listActions((pid) => authorizeProject(ctx.principal, pid));
    return {
      actions: all.map((t) => {
        if (ctx.legacy) return t;
        const { log: _log, ...body } = t.body;
        return { ...t, body };
      }),
    };
  },
});

// --- Commands (global prompt templates) ---

export const commandsList = defineOp({
  name: "commands.list",
  title: "List command templates",
  description: "Lists the global command templates. No input.",
  scope: "tasks:read",
  projectScoped: false,
  input: z.strictObject({}),
  output: z.object({ commands: z.array(CommandTemplateSchema) }),
  rest: { method: "GET", path: "/commands" },
  mcp: { expose: false },
  handler: async (ctx) => ({ commands: await ctx.services.listCommands() }),
});

export const commandsUpsert = defineOp({
  name: "commands.create",
  title: "Create a command template",
  description:
    "Creates or overwrites a command template named by `name`. Inputs: name, body. Writes a template file.",
  scope: "tasks:write",
  projectScoped: false,
  input: z.strictObject(CommandBody.shape),
  output: CommandTemplateSchema,
  rest: { method: "POST", path: "/commands" },
  mcp: { expose: false },
  handler: (ctx, { name, body }) => ctx.services.upsertCommand(name, body ?? ""),
});

export const commandsUpdate = defineOp({
  name: "commands.update",
  title: "Update a command template",
  description:
    "Renames or rewrites a template and repoints the tasks that use it. Inputs: commandId, name, body.",
  scope: "tasks:write",
  projectScoped: false,
  input: z.strictObject({ commandId: commandIdParam, ...CommandBody.shape }),
  output: CommandTemplateSchema,
  rest: { method: "PUT", path: "/commands/{commandId}" },
  mcp: { expose: false },
  handler: (ctx, { commandId, name, body }) =>
    ctx.services.renameCommand(commandId, name, body ?? ""),
});

export const commandsDelete = defineOp({
  name: "commands.delete",
  title: "Delete a command template",
  description:
    "Deletes a template; tasks that referenced it keep their copy. Input: commandId. Removes the file.",
  scope: "tasks:write",
  projectScoped: false,
  input: z.strictObject({ commandId: commandIdParam }),
  output: z.object({ referencedBy: z.array(z.string()) }),
  rest: { method: "DELETE", path: "/commands/{commandId}" },
  mcp: { expose: false },
  handler: (ctx, input) => ctx.services.deleteCommand(input.commandId),
});

// --- API clients (never exposes key hashes) ---

export const clientsList = defineOp({
  name: "auth.clients.list",
  title: "List API clients",
  description: "Lists the API clients without their keys. No input.",
  scope: "auth:admin",
  projectScoped: false,
  input: z.strictObject({}),
  output: z.object({ clients: z.array(PublicClientSchema) }),
  rest: { method: "GET", path: "/auth/clients" },
  mcp: { expose: false },
  handler: async (ctx) => ({
    clients: (await ctx.authStore.list()).map(({ keyHash: _k, ...c }) => c),
  }),
});

export const clientsCreate = defineOp({
  name: "auth.clients.create",
  title: "Create an API client",
  description:
    "Creates an API client and returns its key once. Inputs: name, scopes, optional kind, projects, trust, expiresIn. Cannot grant scopes, trust, projects or an expiry the caller lacks; a restricted caller's projects and expiry are inherited when omitted.",
  scope: "auth:admin",
  projectScoped: false,
  input: CreateClientBody,
  output: z.object({ client: PublicClientSchema, key: z.string() }),
  rest: { method: "POST", path: "/auth/clients", status: 201 },
  mcp: { expose: false },
  handler: async (ctx, body) => {
    const me = ctx.principal;
    // Never grant more than you hold.
    const missing = body.scopes.filter((sc) => !hasScope(me, sc));
    if (missing.length > 0) {
      throw new OpError(
        403,
        `Cannot grant scopes you do not hold: ${missing.join(", ")}`,
        "forbidden_scope",
        {
          scopes: missing,
        },
      );
    }
    if (body.trust === "trusted" && me.trust !== "trusted") {
      throw new OpError(403, "Cannot grant trusted trust", "forbidden_trust");
    }
    // A project-restricted creator cannot grant projects it does not hold; omitted projects are inherited.
    let projects = body.projects;
    const mine = me.projects;
    if (mine !== "*") {
      if (projects === undefined) {
        projects = [...mine];
      } else if (projects === "*") {
        throw new OpError(
          403,
          "Cannot grant every project: this client is restricted",
          "forbidden_project",
          {
            projects: ["*"],
          },
        );
      } else {
        const outside = projects.filter((p) => !mine.has(p));
        if (outside.length > 0) {
          throw new OpError(
            403,
            `Cannot grant projects you may not access: ${outside.join(", ")}`,
            "forbidden_project",
            { projects: outside },
          );
        }
      }
    }
    let expiresAt: string | undefined;
    if (body.expiresIn) {
      try {
        expiresAt = new Date(Date.now() + parseDuration(body.expiresIn)).toISOString();
      } catch (err) {
        throw new OpError(400, (err as Error).message, "invalid_input");
      }
    }
    // An expiring creator cannot mint a key that outlives its own; omitted expiry is inherited.
    const cap = me.kind === "client" ? (await ctx.authStore.get(me.id))?.expiresAt : undefined;
    if (cap) {
      if (!expiresAt) {
        expiresAt = cap;
      } else if (Date.parse(expiresAt) > Date.parse(cap)) {
        throw new OpError(400, "expiresIn outlives the caller's key", "invalid_input", [
          {
            path: "expiresIn",
            message: `Must not outlive the caller's key (expires ${cap})`,
          },
        ]);
      }
    }
    return ctx.authStore.create({
      name: body.name,
      kind: body.kind,
      scopes: body.scopes,
      projects,
      trust: body.trust,
      expiresAt,
    });
  },
});

export const clientsRevoke = defineOp({
  name: "auth.clients.revoke",
  title: "Revoke an API client",
  description: "Revokes a client's key for good. Input: clientId. Marks the client revoked.",
  scope: "auth:admin",
  projectScoped: false,
  input: z.strictObject({ clientId: clientIdParam }),
  output: z.object({ client: PublicClientSchema }),
  rest: { method: "POST", path: "/auth/clients/{clientId}/revoke" },
  mcp: { expose: false, annotations: DESTRUCTIVE },
  handler: async (ctx, input) => {
    const client = await ctx.authStore.revoke(input.clientId);
    if (!client) throw new OpError(404, "Client not found");
    return { client };
  },
});

export const clientsRotate = defineOp({
  name: "auth.clients.rotate",
  title: "Rotate an API client's key",
  description:
    "Issues a new key for a client and invalidates the old one. Input: clientId. Returns the new key once.",
  scope: "auth:admin",
  projectScoped: false,
  input: z.strictObject({ clientId: clientIdParam }),
  output: z.object({ client: PublicClientSchema, key: z.string() }),
  rest: { method: "POST", path: "/auth/clients/{clientId}/rotate" },
  mcp: { expose: false, annotations: WRITE },
  handler: async (ctx, input) => {
    const out = await ctx.authStore.rotate(input.clientId);
    if (!out) throw new OpError(404, "Client not found or revoked");
    return out;
  },
});

export const adminOps = [
  settingsGet,
  settingsUpdate,
  settingsHealth,
  settingsModels,
  settingsModelDetails,
  usageGlobal,
  usageBudget,
  runnerStatus,
  runnerOverview,
  runnerSetEnabled,
  actionsList,
  commandsList,
  commandsUpsert,
  commandsUpdate,
  commandsDelete,
  clientsList,
  clientsCreate,
  clientsRevoke,
  clientsRotate,
];
