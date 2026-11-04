import { z } from "zod";
import { defineOp } from "../define-op.js";
import { AccountSchema, OkSchema, PoolStatusSchema } from "../schemas.js";
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
    if (!(await ctx.services.owlishClient())) return { configured: false, accounts: [] };
    return { configured: true, accounts: await ctx.services.withPool((c) => c.accounts()) };
  },
});

export const accountsHealth = defineOp({
  name: "accounts.health",
  title: "Pool health",
  description:
    "Returns the account pool's health: status (absent, unreachable, ok, degraded, unhealthy), account counts, when the next account is available, and the reason it is not ok; also the gateway address (no credentials), the health gate and where the client key comes from (`file`, `env` or null; the key itself is never returned). Cached for 10 seconds unless `refresh` is true. Input: optional refresh to bypass the cache; concurrent refreshes are coalesced. No side effects.",
  scope: "settings:read",
  projectScoped: false,
  input: z.strictObject({ refresh: z.boolean().optional() }),
  output: z.object({
    configured: z.boolean(),
    url: z.string().nullable().meta({ description: "scheme://host:port of the gateway." }),
    healthGate: z.enum(["pause", "warn", "off"]).nullable(),
    keySource: z.enum(["file", "env"]).nullable(),
    pool: PoolStatusSchema,
  }),
  rest: { method: "GET", path: "/accounts/health" },
  mcp: { expose: true, name: "boof_get_pool_health", annotations: READ },
  summary: (r) =>
    r.configured
      ? `Pool ${r.pool.status}${r.pool.reason ? `: ${r.pool.reason}` : ""}`
      : "No account pool is configured",
  handler: async (ctx, { refresh }) => {
    const pool = await ctx.services.owlishClient().catch(() => null);
    const settings = await ctx.services.loadSettings();
    if (!settings.owlish) {
      return {
        configured: false,
        url: null,
        healthGate: null,
        keySource: null,
        pool: await ctx.services.poolStatus(),
      };
    }
    return {
      configured: true,
      url: new URL(settings.owlish.url).origin,
      healthGate: settings.owlish.healthGate,
      keySource: await ctx.services.owlishSecrets.source().catch(() => null),
      pool: pool ? await pool.client.health(refresh) : await ctx.services.poolStatus(),
    };
  },
});

function accountAction(
  verb: "pause" | "resume",
  title: string,
  tool: string,
  call: (c: import("@boof/owlish").OwlishClient, id: string) => Promise<void>,
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
    await ctx.services.withPool((c) => c.setThresholds(accountId, thresholds));
    return { ok: true as const };
  },
});

export const accountOps = [
  accountsList,
  accountsHealth,
  accountsPause,
  accountsResume,
  accountsPriority,
  accountsThresholds,
];
