import { z } from "zod";
import { OpError } from "../errors.js";
import { defineOp } from "../define-op.js";
import {
  AccountSchema,
  AgentSdkEligibilitySchema,
  OkSchema,
  PoolStatusSchema,
} from "../schemas.js";
import { accountIdParam, IDEMPOTENT_WRITE, READ } from "./common.js";
import { assertMayWriteSettings } from "./admin.js";

// The optional account pool (better-ccflare), reached over HTTP. Account pooling by better-ccflare.
// boof holds no provider credentials: sign-in and adding accounts happen in the better-ccflare
// dashboard. The one client key is never an input or an output of these operations (see
// settings.update, `owlishApiKey`, write-only).

const byAccount = z.strictObject({ accountId: accountIdParam });

export const accountsList = defineOp({
  name: "accounts.list",
  title: "List pool accounts",
  description:
    "Lists the accounts of the better-ccflare pool (id, name, provider, priority, paused, token and rate-limit state). `configured: false` and no accounts when settings.owlish is not set. No input. No side effects. Fails with 502 gateway_error when the gateway cannot be reached.",
  scope: "settings:read",
  projectScoped: false,
  input: z.strictObject({}),
  output: z.object({ configured: z.boolean(), accounts: z.array(AccountSchema) }),
  rest: { method: "GET", path: "/accounts" },
  mcp: { expose: true, name: "boof_list_accounts", annotations: READ },
  summary: (r) =>
    r.configured ? `${r.accounts.length} account(s)` : "No account pool is configured",
  handler: async (ctx) => {
    const mode = await ctx.services.poolMode();
    if (mode === "none" || (mode === "better-ccflare" && !(await ctx.services.owlishClient())))
      return { configured: false, accounts: [] };
    return { configured: true, accounts: await ctx.services.withPool((c) => c.accounts()) };
  },
});

export const accountsAgentSdk = defineOp({
  name: "accounts.agentSdk",
  title: "Claude Agent SDK eligibility",
  description:
    "Checks whether every better-ccflare account uses API-key authentication. Input: optional refresh. No side effects.",
  scope: "settings:read",
  projectScoped: false,
  input: z.strictObject({ refresh: z.boolean().optional() }),
  output: AgentSdkEligibilitySchema,
  rest: { method: "GET", path: "/accounts/agent-sdk" },
  mcp: { expose: true, name: "boof_get_agent_sdk_eligibility", annotations: READ },
  summary: (r) => (r.allowed ? "Claude Agent SDK gateway eligible" : r.reason),
  handler: (ctx, { refresh }) => ctx.services.agentSdkEligibility(refresh === true),
});

export const accountsHealth = defineOp({
  name: "accounts.health",
  title: "Pool health",
  description:
    "Returns the account pool's health: status (absent, unreachable, ok, degraded, unhealthy), account counts, when the next account is available, and the reason it is not ok; also the gateway address (no credentials), the health gate and where the client key comes from (`file`, `env` or null) and where the claude-agent key comes from (`agentKeySource`); neither key is ever returned. Cached for 10 seconds unless `refresh` is true. Input: optional refresh to bypass the cache; concurrent refreshes are coalesced. No side effects.",
  scope: "settings:read",
  projectScoped: false,
  input: z.strictObject({ refresh: z.boolean().optional() }),
  output: z.object({
    configured: z.boolean(),
    url: z.string().nullable().meta({ description: "scheme://host:port of the gateway." }),
    healthGate: z.enum(["pause", "warn", "off"]).nullable(),
    keySource: z.enum(["file", "env"]).nullable(),
    agentKeySource: z.enum(["file", "env"]).nullable().meta({
      description:
        "Where the api-only claude-agent key comes from; null when none is set. The key is never returned.",
    }),
    pool: PoolStatusSchema,
  }),
  rest: { method: "GET", path: "/accounts/health" },
  mcp: { expose: true, name: "boof_get_pool_health", annotations: READ },
  summary: (r) =>
    r.configured
      ? `Pool ${r.pool.status}${r.pool.reason ? `: ${r.pool.reason}` : ""}`
      : "No account pool is configured",
  handler: async (ctx, { refresh }) => {
    const settings = await ctx.services.loadSettings();
    if ((await ctx.services.poolMode()) === "internal") {
      return {
        configured: true,
        url: null,
        healthGate: settings.gateway?.healthGate ?? "pause",
        keySource: null,
        agentKeySource: null,
        pool: await ctx.services.poolStatus(),
      };
    }
    const pool = await ctx.services.owlishClient().catch(() => null);
    if (!settings.owlish) {
      return {
        configured: false,
        url: null,
        healthGate: null,
        keySource: null,
        agentKeySource: null,
        pool: await ctx.services.poolStatus(),
      };
    }
    return {
      configured: true,
      url: new URL(settings.owlish.url).origin,
      healthGate: settings.owlish.healthGate,
      keySource: await ctx.services.owlishSecrets.source().catch(() => null),
      agentKeySource: await ctx.services.owlishSecrets.agentSource().catch(() => null),
      pool: pool ? await pool.client.health(refresh) : await ctx.services.poolStatus(),
    };
  },
});

function accountAction(
  verb: "pause" | "resume",
  title: string,
  tool: string,
  call: (c: import("@boof/owlish").PoolBackend, id: string) => Promise<void>,
) {
  return defineOp({
    name: `accounts.${verb}`,
    title,
    description: `${title} in the better-ccflare pool, at once (the gateway stops or resumes routing to it). Input: accountId. Needs settings:write and a trusted, project-unrestricted client: the pool is shared by every project. 409 not_configured without settings.owlish.`,
    scope: "settings:write",
    projectScoped: false,
    input: byAccount,
    output: OkSchema,
    rest: { method: "POST", path: `/accounts/{accountId}/${verb}` },
    mcp: { expose: true, name: tool, annotations: IDEMPOTENT_WRITE },
    summary: (_r) => `Account ${verb}d`,
    handler: async (ctx, { accountId }) => {
      assertMayWriteSettings(ctx);
      await ctx.services.withPool((c) => call(c, accountId));
      return { ok: true as const };
    },
  });
}

export const accountsPause = accountAction(
  "pause",
  "Pause an account",
  "boof_pause_account",
  (c, id) => c.pause(id),
);
export const accountsResume = accountAction(
  "resume",
  "Resume an account",
  "boof_resume_account",
  (c, id) => c.resume(id),
);

export const accountsPriority = defineOp({
  name: "accounts.priority",
  title: "Set an account's priority",
  description:
    "Sets the routing priority of a pool account: 0 to 100, lower is used first. Inputs: accountId, priority. Needs settings:write and a trusted, project-unrestricted client. 409 not_configured without settings.owlish.",
  scope: "settings:write",
  projectScoped: false,
  input: z.strictObject({
    accountId: accountIdParam,
    priority: z.number().int().min(0).max(100),
  }),
  output: OkSchema,
  rest: { method: "POST", path: "/accounts/{accountId}/priority" },
  mcp: { expose: true, name: "boof_set_account_priority", annotations: IDEMPOTENT_WRITE },
  summary: () => "Account priority set",
  handler: async (ctx, { accountId, priority }) => {
    assertMayWriteSettings(ctx);
    await ctx.services.withPool((c) => c.setPriority(accountId, priority));
    return { ok: true as const };
  },
});

export const accountsThresholds = defineOp({
  name: "accounts.thresholds",
  title: "Set an account's usage-pause thresholds",
  description:
    "Sets when the gateway pauses a pool account on its own: percent (0 to 100, or null for none) of a usage window, for example { fiveHour: 80, weekly: null }. Inputs: accountId, thresholds. Needs settings:write and a trusted, project-unrestricted client. 409 not_configured without settings.owlish.",
  scope: "settings:write",
  projectScoped: false,
  input: z.strictObject({
    accountId: accountIdParam,
    thresholds: z.record(
      z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9]*$/)
        .max(40),
      z.number().min(0).max(100).nullable(),
    ),
  }),
  output: OkSchema,
  rest: { method: "POST", path: "/accounts/{accountId}/thresholds" },
  mcp: { expose: true, name: "boof_set_account_thresholds", annotations: IDEMPOTENT_WRITE },
  summary: () => "Account thresholds set",
  handler: async (ctx, { accountId, thresholds }) => {
    assertMayWriteSettings(ctx);
    if ((await ctx.services.poolMode()) === "internal")
      throw new OpError(
        409,
        "The internal pool has no usage windows to set thresholds on (API keys have per-minute and spend limits)",
        "not_supported",
      );
    await ctx.services.withPool((c) =>
      (c as import("@boof/owlish").OwlishClient).setThresholds(accountId, thresholds),
    );
    return { ok: true as const };
  },
});

const internalOnly = async (ctx: { services: { poolMode(): Promise<string> } }) => {
  const mode = await ctx.services.poolMode();
  if (mode !== "internal")
    throw new OpError(
      409,
      'The internal account pool is not in use: set settings.gateway.mode to "internal" first',
      "not_supported",
    );
};

export const accountsAdd = defineOp({
  name: "accounts.add",
  title: "Add an API-key account",
  description:
    "Adds an Anthropic Console API key (sk-ant-api...) to boof's internal account pool. Inputs: name, apiKey, optional priority (0 to 100, lower is used first). The key is write-only: it is stored in <data>/gateway/accounts.json (mode 0600) and never returned, logged or audited. Subscription (OAuth) tokens are not accepted. Needs settings:write and a trusted, project-unrestricted client. 409 not_supported unless settings.gateway.mode is internal.",
  scope: "settings:write",
  projectScoped: false,
  input: z.strictObject({
    name: z.string().trim().min(1).max(80),
    apiKey: z.string().min(20).max(300).meta({ writeOnly: true }),
    priority: z.number().int().min(0).max(100).optional(),
  }),
  output: z.object({ account: AccountSchema }),
  rest: { method: "POST", path: "/accounts" },
  mcp: { expose: true, name: "boof_add_account", annotations: IDEMPOTENT_WRITE },
  summary: (r) => `Account ${r.account.name} added`,
  handler: async (ctx, input) => {
    assertMayWriteSettings(ctx);
    await internalOnly(ctx);
    const account = await ctx.services.withPool(async () =>
      (await ctx.services.internalPool()).add(input),
    );
    return { account };
  },
});

export const accountsRemove = defineOp({
  name: "accounts.remove",
  title: "Remove an account",
  description:
    "Removes an account from boof's internal account pool and deletes its stored key. Input: accountId. Needs settings:write and a trusted, project-unrestricted client. 409 not_supported unless settings.gateway.mode is internal; 404 when the account does not exist.",
  scope: "settings:write",
  projectScoped: false,
  input: byAccount,
  output: OkSchema,
  rest: { method: "DELETE", path: "/accounts/{accountId}" },
  mcp: { expose: true, name: "boof_remove_account", annotations: IDEMPOTENT_WRITE },
  summary: () => "Account removed",
  handler: async (ctx, { accountId }) => {
    assertMayWriteSettings(ctx);
    await internalOnly(ctx);
    await ctx.services.withPool(async () => (await ctx.services.internalPool()).remove(accountId));
    return { ok: true as const };
  },
});

export const accountOps = [
  accountsList,
  accountsAgentSdk,
  accountsHealth,
  accountsPause,
  accountsResume,
  accountsPriority,
  accountsThresholds,
  accountsAdd,
  accountsRemove,
];
