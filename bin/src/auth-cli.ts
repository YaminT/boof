import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  AuthStore,
  ClientKindSchema,
  parseDuration,
  ScopeSchema,
  SCOPES,
  SettingsStore,
  securitySettings,
  TrustSchema,
  type PublicClient,
  type Scope,
} from "@boof-runner/shared";

export const AUTH_HELP = `boof-runner auth — manage API clients (keys are root-equivalent: anyone who can create a task can run code as you)

Usage:
  boof-runner auth add --name <text> --scopes <a,b,c> [--projects <id,id>|*] [--trust trusted|review]
                       [--expires 30d] [--kind harness|mcp|cli] [-d <data>]
  boof-runner auth list [-d <data>]
  boof-runner auth revoke <id> [-d <data>]
  boof-runner auth rotate <id> [-d <data>]

Scopes: ${SCOPES.join(", ")}
The key is printed once and cannot be recovered; rotate to replace it.`;

function describe(c: PublicClient): string {
  const state = c.revokedAt
    ? "revoked"
    : c.expiresAt && Date.parse(c.expiresAt) <= Date.now()
      ? "expired"
      : "active";
  return [
    c.id.padEnd(24),
    state.padEnd(8),
    c.kind.padEnd(8),
    c.trust.padEnd(8),
    (c.projects === "*" ? "*" : c.projects.join(",")).padEnd(12),
    c.scopes.join(","),
    c.expiresAt ? `expires ${c.expiresAt}` : "",
    c.lastUsedAt ? `last used ${c.lastUsedAt}` : "",
  ]
    .join("  ")
    .trimEnd();
}

/** `auth` subcommand. Returns a process exit code. */
export async function authCommand(
  argv: string[],
  defaultRoot: () => string,
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    out(AUTH_HELP);
    return sub ? 0 : 1;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        data: { type: "string", short: "d" },
        name: { type: "string" },
        scopes: { type: "string" },
        projects: { type: "string" },
        trust: { type: "string" },
        expires: { type: "string" },
        kind: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    err(`auth: ${(e as Error).message}\n`);
    err(AUTH_HELP);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    out(AUTH_HELP);
    return 0;
  }
  const root = values.data
    ? isAbsolute(values.data)
      ? values.data
      : resolve(process.cwd(), values.data)
    : defaultRoot();
  const store = new AuthStore(root);

  switch (sub) {
    case "add": {
      if (!values.name?.trim()) {
        err("auth add: --name is required");
        return 1;
      }
      const scopeNames = (values.scopes ?? "").split(",").filter(Boolean);
      if (scopeNames.length === 0) {
        err(`auth add: --scopes is required (one or more of: ${SCOPES.join(", ")})`);
        return 1;
      }
      const scopes: Scope[] = [];
      for (const s of scopeNames) {
        const r = ScopeSchema.safeParse(s.trim());
        if (!r.success) {
          err(`auth add: unknown scope "${s}" (valid: ${SCOPES.join(", ")})`);
          return 1;
        }
        scopes.push(r.data);
      }
      const trust = TrustSchema.safeParse(values.trust ?? "review");
      if (!trust.success) {
        err("auth add: --trust must be trusted or review");
        return 1;
      }
      const kind = ClientKindSchema.safeParse(values.kind ?? "harness");
      if (!kind.success || kind.data === "ui") {
        err("auth add: --kind must be harness, mcp or cli");
        return 1;
      }
      let expiresAt: string | undefined;
      if (values.expires) {
        try {
          expiresAt = new Date(Date.now() + parseDuration(values.expires)).toISOString();
        } catch (e) {
          err(`auth add: ${(e as Error).message}`);
          return 1;
        }
      }
      const projects =
        !values.projects || values.projects === "*"
          ? "*"
          : values.projects.split(",").map((p) => p.trim());
      const { client, key } = await store.create({
        name: values.name.trim(),
        kind: kind.data,
        scopes,
        projects,
        trust: trust.data,
        expiresAt,
      });
      out(`Created client "${client.id}" (${client.trust} trust).`);
      out("");
      out(`  ${key}`);
      out("");
      out("Store this key now; it is shown once and cannot be recovered.");
      const mode = securitySettings(await new SettingsStore(root).load()).auth.mode;
      if (mode !== "required") {
        out(
          'Note: security.auth.mode is "local-trust"; set it to "required" in settings.json before using --host.',
        );
      }
      return 0;
    }
    case "list": {
      const clients = await store.list();
      if (clients.length === 0) out("No clients.");
      for (const c of clients) {
        const { keyHash: _h, ...pub } = c;
        out(describe(pub));
      }
      return 0;
    }
    case "revoke":
    case "rotate": {
      const id = positionals[0];
      if (!id) {
        err(`auth ${sub}: a client id is required`);
        return 1;
      }
      if (sub === "revoke") {
        const c = await store.revoke(id);
        if (!c) {
          err(`auth revoke: no client "${id}"`);
          return 1;
        }
        out(`Revoked "${id}". It stops working immediately.`);
        return 0;
      }
      const r = await store.rotate(id);
      if (!r) {
        err(`auth rotate: no active client "${id}"`);
        return 1;
      }
      out(`Rotated "${id}". The old key is invalid now. New key:`);
      out("");
      out(`  ${r.key}`);
      out("");
      out("Store this key now; it is shown once.");
      return 0;
    }
    default:
      err(`auth: unknown subcommand "${sub}"\n`);
      err(AUTH_HELP);
      return 1;
  }
}
