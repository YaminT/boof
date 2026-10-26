import { z } from "zod";
import {
  BOOF_VERSION,
  mcpSettings,
  ScopeSchema,
  securitySettings,
  TrustSchema,
} from "@boof-runner/shared";
import { defineOp } from "../define-op.js";
import { READ } from "./common.js";

export const WhoamiSchema = z.object({
  principal: z.object({
    kind: z.enum(["local", "client"]),
    id: z.string(),
    name: z.string(),
    trust: TrustSchema,
    scopes: z.array(ScopeSchema),
    projects: z.union([z.literal("*"), z.array(z.string())]),
  }),
  server: z.object({
    version: z.string(),
    authMode: z.enum(["local-trust", "required"]),
    mcpEnabled: z.boolean(),
  }),
});

export const whoami = defineOp({
  name: "auth.whoami",
  title: "Who am I",
  description:
    "Returns the calling principal (kind, id, name, trust, scopes, projects) and basic server facts (version, auth mode, whether MCP is enabled). No input. Needs no scope; any authenticated caller may use it. No side effects.",
  scope: [],
  projectScoped: false,
  input: z.strictObject({}),
  output: WhoamiSchema,
  rest: { method: "GET", path: "/whoami" },
  mcp: { expose: true, name: "boof_whoami", annotations: READ },
  summary: (r) =>
    `${r.principal.name} (${r.principal.kind}, ${r.principal.trust} trust), scopes: ${r.principal.scopes.join(", ") || "none"}`,
  handler: async (ctx) => {
    const settings = await ctx.services.loadSettings();
    const p = ctx.principal;
    return {
      principal: {
        kind: p.kind,
        id: p.id,
        name: p.name,
        trust: p.trust,
        scopes: [...p.scopes].sort(),
        projects: p.projects === "*" ? ("*" as const) : [...p.projects].sort(),
      },
      server: {
        version: BOOF_VERSION,
        authMode: securitySettings(settings).auth.mode,
        mcpEnabled: mcpSettings(settings).enabled,
      },
    };
  },
});

export const whoamiOps = [whoami];
