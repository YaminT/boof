import { z } from "zod";
import {
  authorizeProject,
  hasScope,
  parseDuration,
  SettingsPatchSchema,
  settingsVersion,
  TokenUsageSchema,
} from "@boof/heart";
import { AGENT_KEY_MUST_BE_SEPARATE, OwlishClient } from "@boof/owlish";
import { defineOp, type OpContext } from "../define-op.js";
import { OpError } from "../errors.js";
import { buildModelDetails } from "../services/model-details.js";
import type { Client } from "@boof/heart";
import { CommandBody, CreateClientBody } from "../validation.js";
import {
  CommandRenameSchema,
  CommandTemplateSchema,
  HealthResultSchema,
  ModelDetailsSchema,
  PublicClientSchema,
  BudgetExceededListSchema,
  BudgetStatusSchema,
  AgentAuthStatusSchema,
  PoolStatusSchema,
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
export function publicSettings<T extends { webhooks?: unknown; n8n?: unknown }>(
  s: T,
): Omit<T, "webhooks" | "n8n"> {
  const { webhooks: _w, n8n: _n, ...rest } = s;
  return rest;
}

const settingsEtag = (s: { webhooks?: unknown }) => `W/"${settingsVersion(s)}"`;

/** The catalog hands out read-only lists; a response owns its own copy. */
const mutableLists = (m: Readonly<Record<string, readonly string[]>>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v]]));

export const settingsGet = defineOp({
  name: "settings.get",
  title: "Get settings",
  description:
    "Returns the global settings (runner, roles, review, security, models). No side effects.",
  scope: "settings:read",
  projectScoped: false,
  input: z.strictObject({}),
  output: PublicSettingsSchema,
  rest: { method: "GET", path: "/settings", etag: settingsEtag },
  mcp: { expose: true, name: "boof_get_settings", annotations: READ },
  summary: (s) =>
    `Runner ${s.runner.enabled ? "enabled" : "disabled"}, default project ${s.defaultProject ?? "none"}`,
  handler: async (ctx) => publicSettings(await ctx.services.loadSettings()),
});

export const settingsUpdate = defineOp({
  name: "settings.update",
  title: "Update settings",
  description:
    "Changes global settings, including owlish gateway settings and its write-only client key. Rewrites settings.json. Needs settings:write and a trusted, project-unrestricted client: settings are global.",
  scope: "settings:write",
  projectScoped: false,
  input: SettingsPatchSchema.extend({
    expectedUpdated: z.string().max(100).optional().meta({
      description:
        "The settings ETag you last saw (HTTP: If-Match). A stale value is refused with 409 settings_modified. Omit it for an unconditional write.",
    }),
    owlishApiKey: z
      .string()
      .regex(/^[\x21-\x7e]{1,512}$/)
      .nullable()
      .optional()
      .meta({
        description:
          "boof's better-ccflare client key. Write-only: stored apart from settings.json (owlish/secrets.json, mode 0600) and never returned. null removes the stored key (BOOF_OWLISH_API_KEY, when set, still wins).",
        writeOnly: true,
      }),
    owlishAgentKey: z
      .string()
      .regex(/^[\x21-\x7e]{1,512}$/)
      .nullable()
      .optional()
      .meta({
        description:
          "An api-only better-ccflare key that claude-agent processes receive as ANTHROPIC_API_KEY; boof keeps the admin client key to itself. Write-only: stored beside the client key (owlish/secrets.json, mode 0600) and never returned. null removes the stored key (BOOF_OWLISH_AGENT_KEY, when set, still wins).",
        writeOnly: true,
      }),
  }),
  output: PublicSettingsSchema,
  rest: { method: "PUT", path: "/settings", ifMatch: "expectedUpdated", etag: settingsEtag },
  mcp: { expose: true, name: "boof_update_settings", annotations: IDEMPOTENT_WRITE },
  summary: () => "Settings updated",
  handler: async (ctx, { expectedUpdated, owlishApiKey, owlishAgentKey, ...patch }) => {
    assertMayWriteSettings(ctx);
    const saved = await ctx.services.updateSettings(patch, ctx.principal, expectedUpdated);
    // Write the separate secret only after settings and its ETag check succeeded.
    if (typeof owlishApiKey === "string") {
      try {
        await ctx.services.owlishSecrets.set(owlishApiKey);
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes("agent key must be a separate") ||
            error.message.startsWith("owlish/secrets.json"))
        )
          throw new OpError(400, error.message, "invalid_input");
        throw error;
      }
    } else if (owlishApiKey === null) await ctx.services.owlishSecrets.delete();
    if (typeof owlishAgentKey === "string") {
      try {
        // A second admin key is a different string. Ask the admin-only account list before
        // storing it. No gateway URL yet, or no answer, still stores: the next use probes again.
        const gatewayUrl = saved.owlish?.url;
        if (gatewayUrl) {
          const probe = await new OwlishClient({
            url: gatewayUrl,
            apiKey: owlishAgentKey,
          }).probeAdminRoute();
          if (probe === "accepted") throw new Error(AGENT_KEY_MUST_BE_SEPARATE);
        }
        await ctx.services.owlishSecrets.setAgent(owlishAgentKey);
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes("agent key must be a separate") ||
            error.message.startsWith("owlish/secrets.json"))
        )
          throw new OpError(400, error.message, "invalid_input");
        throw error;
      }
    } else if (owlishAgentKey === null) await ctx.services.owlishSecrets.deleteAgent();
    return publicSettings(saved);
  },
});

export const settingsHealth = defineOp({
  name: "settings.health",
  title: "Tool health",
  description:
    "Returns the last health check of each agent tool (claude-code, codex, opencode) made by this server process, with its time (checkedAt); empty until settings.checkHealth ran. No input. No side effects: it runs no tool.",
  scope: "settings:read",
  projectScoped: false,
  input: z.strictObject({}),
  output: z.object({ tools: z.record(z.string(), HealthResultSchema) }),
  rest: { method: "GET", path: "/health" },
  mcp: { expose: true, name: "boof_get_health", annotations: READ },
  summary: (r) =>
    Object.entries(r.tools)
      .map(([k, v]) => `${k}: ${v.status}`)
      .join(", "),
  handler: async (ctx) => ({
    tools: Object.fromEntries(
      Object.entries(ctx.services.cachedHealth()).map(([id, health]) => [
        id,
        {
          ...health,
          ...(ctx.services.catalog.get(id)?.unavailableReason
            ? { unavailableReason: ctx.services.catalog.get(id)!.unavailableReason }
            : {}),
        },
      ]),
    ),
  }),
});

export const settingsCheckHealth = defineOp({
  name: "settings.checkHealth",
  title: "Check tool health",
  description:
    "Checks that each agent tool (claude-code, codex, opencode) is installed and usable, and remembers the result for settings.health. No input. Spawns each tool and sends it a short prompt (a paid model call per tool). Concurrent calls share one check, and a check less than a minute old is not repeated. Needs settings:write.",
  scope: "settings:write",
  projectScoped: false,
  input: z.strictObject({}),
  output: z.object({ tools: z.record(z.string(), HealthResultSchema) }),
  rest: { method: "POST", path: "/health/check" },
  mcp: { expose: true, name: "boof_check_health", annotations: WRITE },
  summary: (r) =>
    Object.entries(r.tools)
      .map(([k, v]) => `${k}: ${v.status}`)
      .join(", "),
  handler: async (ctx) => {
    await ctx.services.health();
    return {
      tools: Object.fromEntries(
        Object.entries(ctx.services.cachedHealth()).map(([id, health]) => [
          id,
          {
            ...health,
            ...(ctx.services.catalog.get(id)?.unavailableReason
              ? { unavailableReason: ctx.services.catalog.get(id)!.unavailableReason }
              : {}),
          },
        ]),
      ),
    };
  },
});

export const settingsModels = defineOp({
  name: "settings.models",
  title: "List models",
  description:
    "Lists the models each tool offers, as last fetched by this server process (the built-in defaults until settings.refreshModels ran). No input. No side effects: it runs no tool.",
  scope: "settings:read",
  projectScoped: false,
  input: z.strictObject({}),
  output: z.object({ models: z.record(z.string(), z.array(z.string())) }),
  rest: { method: "GET", path: "/models" },
  mcp: { expose: true, name: "boof_list_models", annotations: READ },
  summary: (r) => Object.keys(r.models).join(", "),
  handler: async (ctx) => ({ models: mutableLists(ctx.services.cachedModels()) }),
});

export const settingsRefreshModels = defineOp({
  name: "settings.refreshModels",
  title: "Refresh models",
  description:
    "Asks each tool for its current model list and remembers it for settings.models and models.details. No input. Queries the tools (spawns processes); concurrent calls share one query.",
  scope: "settings:read",
  projectScoped: false,
  input: z.strictObject({}),
  output: z.object({ models: z.record(z.string(), z.array(z.string())) }),
  rest: { method: "POST", path: "/models/refresh" },
  mcp: { expose: true, name: "boof_refresh_models", annotations: WRITE },
  summary: (r) => Object.keys(r.models).join(", "),
  handler: async (ctx) => ({ models: mutableLists(await ctx.services.listModels()) }),
});

export const settingsModelDetails = defineOp({
  name: "models.details",
  title: "Model details",
  description:
    "Lists each tool's models with their source (live CLI list, built-in default or settings), whether each is the default, the roles that use it, and the last health result of this server process (null if none ran). No input. Lists models only; runs no tool (it uses the lists settings.refreshModels last fetched).",
  scope: "settings:read",
  projectScoped: false,
  input: z.strictObject({}),
  output: ModelDetailsSchema,
  rest: { method: "GET", path: "/models/details" },
  mcp: { expose: true, name: "boof_get_model_details", annotations: READ },
  summary: (r) =>
    Object.entries(r.tools)
      .map(([k, v]) => `${k}: ${v.models.length} model(s)`)
      .join(", "),
  handler: async (ctx) => {
    const settings = await ctx.services.loadSettings();
    const projects = (await ctx.services.listProjects()).filter((p) =>
      authorizeProject(ctx.principal, p.id),
    );
    const { catalog } = ctx.services;
    return {
      tools: buildModelDetails({
        tools: catalog.list(),
        live: catalog.cachedLiveModels(),
        settings,
        projects,
        health: catalog.lastHealth(),
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
  mcp: { expose: true, name: "boof_get_usage", annotations: READ },
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
  mcp: { expose: true, name: "boof_get_budget", annotations: READ },
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
    /** The account pool (absent when settings.owlish is not set). */
    pool: PoolStatusSchema,
    agentAuth: AgentAuthStatusSchema,
  }),
  rest: { method: "GET", path: "/runner" },
  mcp: { expose: true, name: "boof_get_runner", annotations: READ },
  summary: (r) => `Runner ${r.enabled ? "enabled" : "disabled"} (concurrency ${r.concurrency})`,
  handler: async (ctx) => {
    const { runner } = await ctx.services.loadSettings();
    const budget = await ctx.services.budgetStatus((pid) => authorizeProject(ctx.principal, pid));
    return {
      enabled: runner.enabled,
      concurrency: runner.concurrency,
      budgetExceeded: budget.exceeded,
      pool: await ctx.services.poolStatus(),
      agentAuth: await ctx.services.agentAuthStatus((pid: string) =>
        authorizeProject(ctx.principal, pid),
      ),
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
    /** The account pool (absent when settings.owlish is not set). */
    pool: PoolStatusSchema,
    agentAuth: AgentAuthStatusSchema,
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
      const { counts, running } = await ctx.services.forProject(p.id).statusSummary();
      projects.push({
        id: p.id,
        paused: p.paused,
        running,
        counts,
      });
    }
    const budget = await ctx.services.budgetStatus((pid) => authorizeProject(ctx.principal, pid));
    return {
      enabled: runner.enabled,
      concurrency: runner.concurrency,
      budgetExceeded: budget.exceeded,
      pool: await ctx.services.poolStatus(),
      agentAuth: await ctx.services.agentAuthStatus((pid: string) =>
        authorizeProject(ctx.principal, pid),
      ),
      projects,
    };
  },
});

export const runnerSetEnabled = defineOp({
  name: "runner.setEnabled",
  title: "Start or pause the runner",
  description:
    "Turns the runner on or off for every project. Input: enabled. Writes settings.json and appends a runner.enabled event. A review-trust key is refused (403 forbidden_trust) and so is a project-restricted one (403 forbidden_project); it can pause its own projects.",
  scope: ["runner:control", "settings:write"],
  projectScoped: false,
  input: z.strictObject({ enabled: z.boolean() }),
  output: z.object({ enabled: z.boolean(), concurrency: z.number().int() }),
  rest: { method: "PUT", path: "/runner" },
  mcp: { expose: true, name: "boof_set_runner", annotations: IDEMPOTENT_WRITE },
  summary: (r) => `Runner ${r.enabled ? "enabled" : "disabled"}`,
  handler: async (ctx, input) => {
    // The toggle is global: a review-trust key may not use it, and a project-restricted key has
    // projects.pause and projects.resume.
    if (ctx.principal.trust !== "trusted") {
      throw new OpError(
        403,
        "The runner switch covers every project: only trusted clients may use it",
        "forbidden_trust",
      );
    }
    if (ctx.principal.projects !== "*") {
      throw new OpError(
        403,
        "The runner switch covers every project: a project-restricted key may not use it (pause the project instead)",
        "forbidden_project",
      );
    }
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
  mcp: { expose: true, name: "boof_list_commands", annotations: READ },
  summary: (r) => `${r.commands.length} command templates`,
  handler: async (ctx) => ({ commands: await ctx.services.listCommands() }),
});

/** Templates are global and a rename rewrites tasks in every project: trusted, unrestricted callers only. */
function assertMayWriteCommands(ctx: OpContext): void {
  const me = ctx.principal;
  if (me.trust !== "trusted" || me.projects !== "*") {
    throw new OpError(
      403,
      "Command templates are global: only trusted clients without a project restriction may change them",
      "forbidden_trust",
    );
  }
}

/** Settings are global (roles, budgets, worktree, security): trusted, unrestricted callers only. */
export function assertMayWriteSettings(ctx: OpContext): void {
  const me = ctx.principal;
  if (me.trust !== "trusted" || me.projects !== "*") {
    throw new OpError(
      403,
      "Settings are global: only trusted clients without a project restriction may change them",
      "forbidden_trust",
    );
  }
}

export const commandsUpsert = defineOp({
  name: "commands.create",
  title: "Create a command template",
  description:
    "Creates or overwrites a command template named by `name`. Inputs: name, body. Writes a template file. Needs settings:write and a trusted, project-unrestricted client: templates are global, and a rename repoints tasks in every project.",
  scope: "settings:write",
  projectScoped: false,
  input: z.strictObject(CommandBody.shape),
  output: CommandTemplateSchema,
  rest: { method: "POST", path: "/commands" },
  mcp: { expose: true, name: "boof_create_command", annotations: WRITE },
  summary: (r) => `Saved command ${r.name}`,
  handler: (ctx, { name, body }) => {
    assertMayWriteCommands(ctx);
    return ctx.services.upsertCommand(name, body ?? "");
  },
});

export const commandsUpdate = defineOp({
  name: "commands.update",
  title: "Update a command template",
  description:
    "Renames or rewrites a template and repoints the tasks that use it, except running ones (listed in `skippedTasks`; they keep their copy). Inputs: commandId, name, body. Needs settings:write and a trusted, project-unrestricted client: templates are global, and a rename repoints tasks in every project.",
  scope: "settings:write",
  projectScoped: false,
  input: z.strictObject({ commandId: commandIdParam, ...CommandBody.shape }),
  output: CommandRenameSchema,
  rest: { method: "PUT", path: "/commands/{commandId}" },
  mcp: { expose: true, name: "boof_update_command", annotations: IDEMPOTENT_WRITE },
  summary: (r) => `Saved command ${r.name}`,
  handler: (ctx, { commandId, name, body }) => {
    assertMayWriteCommands(ctx);
    return ctx.services.renameCommand(commandId, name, body ?? "");
  },
});

export const commandsDelete = defineOp({
  name: "commands.delete",
  title: "Delete a command template",
  description:
    "Deletes a template; tasks that referenced it keep their copy. Input: commandId. Removes the file. Needs settings:write and a trusted, project-unrestricted client: templates are global, and a delete reports references from every project.",
  scope: "settings:write",
  projectScoped: false,
  input: z.strictObject({ commandId: commandIdParam }),
  output: z.object({ referencedBy: z.array(z.string()) }),
  rest: { method: "DELETE", path: "/commands/{commandId}" },
  mcp: { expose: true, name: "boof_delete_command", annotations: DESTRUCTIVE },
  summary: (r) => `Deleted command; referenced by ${r.referencedBy.length} tasks`,
  handler: (ctx, input) => {
    assertMayWriteCommands(ctx);
    return ctx.services.deleteCommand(input.commandId);
  },
});

// --- API clients (never exposes key hashes) ---

/** True when `expiresAt` (none = never) is later than the caller's cap (none = no cap). */
function outlivesCap(expiresAt: string | undefined, cap: string | undefined): boolean {
  if (!cap) return false;
  return !expiresAt || Date.parse(expiresAt) > Date.parse(cap);
}

/** Why `me` may not manage `target` (rotate, revoke, list), or null when it may. */
async function manageRefusal(ctx: OpContext, target: Client): Promise<OpError | null> {
  const me = ctx.principal;
  if (me.kind === "client" && target.id === me.id) return null;
  const missing = target.scopes.filter((sc) => !hasScope(me, sc));
  if (missing.length > 0) {
    return new OpError(
      403,
      `Client holds scopes you do not hold: ${missing.join(", ")}`,
      "forbidden_scope",
      { scopes: missing },
    );
  }
  if (target.trust === "trusted" && me.trust !== "trusted") {
    return new OpError(403, "Client has trusted trust; you do not", "forbidden_trust");
  }
  const mine = me.projects;
  if (mine !== "*") {
    const outside = target.projects === "*" ? ["*"] : target.projects.filter((p) => !mine.has(p));
    if (outside.length > 0) {
      return new OpError(403, "Client reaches projects you may not access", "forbidden_project", {
        projects: outside,
      });
    }
  }
  const cap = me.kind === "client" ? (await ctx.authStore.get(me.id))?.expiresAt : undefined;
  if (outlivesCap(target.expiresAt, cap)) {
    return new OpError(403, "Client outlives your key", "forbidden_scope");
  }
  return null;
}

/**
 * A client the caller may not manage answers exactly like an unknown id (404), so the answer does
 * not reveal that the client exists or what it may do.
 */
async function assertMayManage(ctx: OpContext, target: Client, notFound: string): Promise<void> {
  if (await manageRefusal(ctx, target)) throw new OpError(404, notFound);
}

async function visibleClients(ctx: OpContext) {
  const out = [];
  for (const { keyHash: _k, ...c } of await ctx.authStore.list()) {
    if ((await manageRefusal(ctx, { ...c, keyHash: _k })) === null) out.push(c);
  }
  return out;
}

export const clientsList = defineOp({
  name: "auth.clients.list",
  title: "List API clients",
  description:
    "Lists the API clients without their keys. No input. Shows only the clients the caller may manage (and itself).",
  scope: "auth:admin",
  projectScoped: false,
  input: z.strictObject({}),
  output: z.object({ clients: z.array(PublicClientSchema) }),
  rest: { method: "GET", path: "/auth/clients" },
  mcp: { expose: true, name: "boof_list_clients", annotations: READ },
  summary: (r) => `${r.clients.length} clients`,
  handler: async (ctx) => ({
    clients: await visibleClients(ctx),
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
  mcp: { expose: true, name: "boof_create_client", annotations: WRITE },
  summary: (r) =>
    `Created client ${r.client.id} (${r.client.scopes.join(", ")}; ${r.client.trust}); the key is in the result and is shown only once`,
  handler: async (ctx, body) => {
    const me = ctx.principal;
    // `ui` marks the desktop app's own key, which it makes itself; `auth add` refuses it too.
    if (body.kind === "ui") {
      throw new OpError(400, "Invalid input", "invalid_input", [
        { path: "kind", message: "kind ui is reserved for the desktop app's own key" },
      ]);
    }
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
      } else if (outlivesCap(expiresAt, cap)) {
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
      randomSuffix: true,
    });
  },
});

export const clientsRevoke = defineOp({
  name: "auth.clients.revoke",
  title: "Revoke an API client",
  description:
    "Revokes a client's key for good. Input: clientId. Marks the client revoked. A client with more scopes, trust, projects or expiry than the caller answers 404, like an unknown id.",
  scope: "auth:admin",
  projectScoped: false,
  input: z.strictObject({ clientId: clientIdParam }),
  output: z.object({ client: PublicClientSchema }),
  rest: { method: "POST", path: "/auth/clients/{clientId}/revoke" },
  mcp: { expose: true, name: "boof_revoke_client", annotations: DESTRUCTIVE },
  summary: (r) => `Revoked client ${r.client.id}`,
  handler: async (ctx, input) => {
    const target = await ctx.authStore.get(input.clientId);
    if (!target) throw new OpError(404, "Client not found");
    await assertMayManage(ctx, target, "Client not found");
    const client = await ctx.authStore.revoke(input.clientId);
    if (!client) throw new OpError(404, "Client not found");
    return { client };
  },
});

export const clientsRotate = defineOp({
  name: "auth.clients.rotate",
  title: "Rotate an API client's key",
  description:
    "Issues a new key for a client and invalidates the old one. Input: clientId. Returns the new key once. A client with more scopes, trust, projects or expiry than the caller answers 404, like an unknown id.",
  scope: "auth:admin",
  projectScoped: false,
  input: z.strictObject({ clientId: clientIdParam }),
  output: z.object({ client: PublicClientSchema, key: z.string() }),
  rest: { method: "POST", path: "/auth/clients/{clientId}/rotate" },
  mcp: { expose: true, name: "boof_rotate_client", annotations: WRITE },
  summary: (r) =>
    `Rotated the key of ${r.client.id}; the new key is in the result and is shown only once`,
  handler: async (ctx, input) => {
    const target = await ctx.authStore.get(input.clientId);
    if (!target) throw new OpError(404, "Client not found or revoked");
    await assertMayManage(ctx, target, "Client not found or revoked");
    const out = await ctx.authStore.rotate(input.clientId);
    if (!out) throw new OpError(404, "Client not found or revoked");
    return out;
  },
});

export const adminOps = [
  settingsGet,
  settingsUpdate,
  settingsHealth,
  settingsCheckHealth,
  settingsModels,
  settingsRefreshModels,
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
