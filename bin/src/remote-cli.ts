import { existsSync } from "node:fs";
import { chmod, readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  AuthStore,
  dataRootPaths,
  lockedAtomicWrite,
  parseDuration,
  ScopeSchema,
  SCOPES,
  SettingsSchema,
  securitySettings,
  toKebabId,
  TrustSchema,
  type Scope,
  type Settings,
} from "@boof-runner/shared";
import { assertBindAllowed } from "@boof-runner/web";
import { scaffoldDataRoot } from "./scaffold.js";

/** The "full harness" scope set from docs/harness.md: everything except settings writes, clients and webhooks. */
export const FULL_HARNESS_SCOPES =
  "projects:read,projects:write,plans:read,plans:write,tasks:read,tasks:write,tasks:control,settings:read,runner:control";

const GUIDE_URL = "https://nodets.com/boof/harness.txt";

export const REMOTE_HELP = `boof-runner remote — expose this boof server to a remote AI harness in one command

Usage:
  boof-runner remote setup --hostname <public-host> [--allowed-root <dir>]... [--name <client>] [--scopes <list>]
                           [--trust review|trusted] [--expires 30d] [--no-key] [--port <n>] [-d <data>]
  boof-runner remote status [-d <data>]
  boof-runner remote disable [-d <data>]

setup   Sets security.auth.mode = "required", adds the host name to security.allowedHosts and each
        --allowed-root to security.allowedProjectRoots, creates an API client (key printed once; default
        name "harness", scopes = the full harness set, trust review) and restricts the data root to
        your user (chmod 700). Prints the next steps. Safe to run again: nothing is duplicated.
        --no-key skips creating a client. If the client name is taken it changes nothing and exits 1
        (use "auth rotate <id>").
status  Shows the auth mode, allowed hosts and roots, active clients, data root permissions and whether
        a non-loopback bind is allowed right now.
disable Sets security.auth.mode back to "local-trust". Hosts, roots and clients are kept.

Default scopes: ${FULL_HARNESS_SCOPES}
All scopes: ${SCOPES.join(", ")}`;

/** "https://Boof.Example.com:8443/path" -> "boof.example.com"; null when it is not a host name. */
export function normaliseHostname(input: string): string | null {
  let h = input.trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  h = h.split(/[/?#]/)[0] ?? "";
  h = h.replace(/^[^@]*@/, "");
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    h = end === -1 ? "" : h.slice(0, end + 1);
  } else {
    h = h.replace(/:\d*$/, "");
  }
  h = h.replace(/\.$/, "");
  return /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9._-]*[a-z0-9])?)$/.test(h) ? h : null;
}

/** `~` and `~/x` stay as given (the server expands them); anything else becomes absolute. */
export function normaliseRoot(input: string): string {
  const p = input.trim();
  if (p === "~" || p.startsWith("~/")) return p.length > 2 ? p.replace(/\/+$/, "") : p;
  return resolve(process.cwd(), p);
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

/** Read settings.json as raw JSON so keys this version does not know about survive the write. */
async function readRawSettings(root: string): Promise<Record<string, unknown>> {
  const raw: unknown = JSON.parse(await readFile(dataRootPaths(root).settings, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("settings.json is not an object");
  if (!("schemaVersion" in raw)) {
    throw new Error(
      "settings.json is a v1 file; start boof-runner (any command) to migrate the data root",
    );
  }
  return raw as Record<string, unknown>;
}

async function writeRawSettings(root: string, raw: Record<string, unknown>): Promise<void> {
  SettingsSchema.parse(raw); // never write something the server cannot load
  await lockedAtomicWrite(dataRootPaths(root).settings, JSON.stringify(raw, null, 2) + "\n");
}

function securityBlock(raw: Record<string, unknown>): Record<string, unknown> {
  const s = raw.security;
  return s && typeof s === "object" && !Array.isArray(s)
    ? { ...(s as Record<string, unknown>) }
    : {};
}

function withAuthMode(sec: Record<string, unknown>, mode: "required" | "local-trust") {
  const auth =
    sec.auth && typeof sec.auth === "object" ? (sec.auth as Record<string, unknown>) : {};
  return { ...sec, auth: { ...auth, mode } };
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

async function modeOf(root: string): Promise<number | null> {
  if (process.platform === "win32") return null;
  try {
    return (await stat(root)).mode & 0o777;
  } catch {
    return null;
  }
}

async function bindVerdict(root: string, settings: Settings): Promise<string> {
  try {
    await assertBindAllowed("0.0.0.0", settings, new AuthStore(root));
    return "allowed";
  } catch (e) {
    return `refused (${(e as Error).message.replace(/^refusing to bind [^:]+: /, "")})`;
  }
}

/** `remote` subcommand. Returns a process exit code. */
export async function remoteCommand(
  argv: string[],
  defaultRoot: () => string,
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    out(REMOTE_HELP);
    return sub ? 0 : 1;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      options: {
        data: { type: "string", short: "d" },
        hostname: { type: "string" },
        "allowed-root": { type: "string", multiple: true },
        name: { type: "string" },
        scopes: { type: "string" },
        trust: { type: "string" },
        expires: { type: "string" },
        "no-key": { type: "boolean" },
        port: { type: "string", short: "p" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    err(`remote: ${(e as Error).message}\n`);
    err(REMOTE_HELP);
    return 1;
  }
  const v = parsed.values;
  if (v.help) {
    out(REMOTE_HELP);
    return 0;
  }
  const root = v.data
    ? isAbsolute(v.data)
      ? v.data
      : resolve(process.cwd(), v.data)
    : defaultRoot();

  try {
    switch (sub) {
      case "setup":
        return await setup(root, v, out, err);
      case "status":
        return await status(root, out, err);
      case "disable":
        return await disable(root, out, err);
      default:
        err(`remote: unknown subcommand "${sub}"\n`);
        err(REMOTE_HELP);
        return 1;
    }
  } catch (e) {
    err(`remote ${sub}: ${(e as Error).message}`);
    return 1;
  }
}

type Values = ReturnType<typeof parseArgs>["values"];

async function setup(
  root: string,
  v: Values,
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  const rawHost = v.hostname as string | undefined;
  if (!rawHost) {
    err("remote setup: --hostname <public-host> is required");
    return 1;
  }
  const hostname = normaliseHostname(rawHost);
  if (!hostname) {
    err(`remote setup: "${rawHost}" is not a valid host name`);
    return 1;
  }
  const port = Number((v.port as string | undefined) ?? process.env.BOOF_RUNNER_PORT ?? 4319);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    err("remote setup: --port must be 1-65535");
    return 1;
  }
  const noKey = Boolean(v["no-key"]);
  const name = ((v.name as string | undefined) ?? "harness").trim();
  const scopes: Scope[] = [];
  const trust = TrustSchema.safeParse((v.trust as string | undefined) ?? "review");
  let expiresAt: string | undefined;
  if (!noKey) {
    if (!name) {
      err("remote setup: --name must not be empty");
      return 1;
    }
    for (const s of ((v.scopes as string | undefined) ?? FULL_HARNESS_SCOPES)
      .split(",")
      .filter(Boolean)) {
      const r = ScopeSchema.safeParse(s.trim());
      if (!r.success) {
        err(`remote setup: unknown scope "${s}" (valid: ${SCOPES.join(", ")})`);
        return 1;
      }
      scopes.push(r.data);
    }
    if (scopes.length === 0) {
      err("remote setup: --scopes must list at least one scope");
      return 1;
    }
    if (!trust.success) {
      err("remote setup: --trust must be review or trusted");
      return 1;
    }
    if (v.expires) {
      try {
        expiresAt = new Date(Date.now() + parseDuration(v.expires as string)).toISOString();
      } catch (e) {
        err(`remote setup: ${(e as Error).message}`);
        return 1;
      }
    }
  }

  await scaffoldDataRoot(root);
  const store = new AuthStore(root);

  // Check the client name before touching anything, so a refusal leaves settings unchanged.
  if (!noKey) {
    const id = toKebabId(name);
    const taken = (await store.list()).find(
      (c) => !c.revokedAt && (c.id === id || c.name.toLowerCase() === name.toLowerCase()),
    );
    if (taken) {
      err(
        `remote setup: a client named "${name}" already exists (id "${taken.id}"). Settings were not changed.\n` +
          `Run "boof-runner auth rotate ${taken.id}" for a new key, pass --name <other>, or --no-key to only update settings.`,
      );
      return 1;
    }
  }

  const raw = await readRawSettings(root);
  const sec = securityBlock(raw);
  const roots = ((v["allowed-root"] as string[] | undefined) ?? []).map(normaliseRoot);
  const next = {
    ...withAuthMode(sec, "required"),
    allowedHosts: dedupe([...strings(sec.allowedHosts), hostname]),
    allowedProjectRoots: dedupe([...strings(sec.allowedProjectRoots), ...roots]),
  };
  await writeRawSettings(root, { ...raw, security: next });
  out(`Settings updated in ${dataRootPaths(root).settings}`);
  out(`  security.auth.mode           = required`);
  out(`  security.allowedHosts        = ${JSON.stringify(next.allowedHosts)}`);
  out(`  security.allowedProjectRoots = ${JSON.stringify(next.allowedProjectRoots)}`);
  if (next.allowedProjectRoots.length === 0) {
    out(
      "  (no allowed roots: the harness cannot register projects; add some with --allowed-root <dir>)",
    );
  }

  const mode = await modeOf(root);
  if (mode !== null && mode & 0o077) {
    await chmod(root, 0o700);
    out(
      `Data root ${root} was accessible to other users (mode ${mode.toString(8)}); ran chmod 700.`,
    );
  }

  let key: string | undefined;
  if (!noKey) {
    const created = await store.create({
      name,
      kind: "harness",
      scopes,
      projects: "*",
      trust: trust.success ? trust.data : "review",
      expiresAt,
    });
    key = created.key;
    out("");
    out(`Created client "${created.client.id}" (${created.client.trust} trust).`);
    out("");
    out(`  ${key}`);
    out("");
    out("Store this key now; it is shown once and cannot be recovered (auth rotate replaces it).");
  } else {
    out(
      "No client created (--no-key). Create one with: boof-runner auth add --name <name> --scopes <list>",
    );
  }

  const dataFlag = process.env.BOOF_RUNNER_DATA_ROOT === root ? "" : ` -d ${quote(root)}`;
  out("");
  out("Next steps");
  out("");
  out("1. Make the server reachable. Pick one:");
  out("");
  out("   a) TLS directly (you hold a certificate for the host name):");
  out(
    `      boof-runner serve${dataFlag} --host 0.0.0.0 -p ${port} --tls-cert <cert.pem> --tls-key <key.pem>`,
  );
  out("");
  out("   b) Tunnel or reverse proxy (keeps boof on loopback; the proxy terminates TLS):");
  out(`      boof-runner serve${dataFlag} --host 127.0.0.1 -p ${port}`);
  out(
    `      Forward https://${hostname} to http://127.0.0.1:${port} and keep the original Host header.`,
  );
  out("      Caddy (Caddyfile):");
  out(`        ${hostname} {`);
  out(`          reverse_proxy 127.0.0.1:${port}`);
  out("        }");
  out("      Cloudflare tunnel:");
  out(`        cloudflared tunnel --url http://127.0.0.1:${port}`);
  out(
    `      The public host name must be in security.allowedHosts (done: ${hostname}); any other Host answers 421.`,
  );
  out("");
  out("2. Give the AI harness:");
  out(`   BOOF_URL=https://${hostname}`);
  out(`   the key${key ? " printed above" : " (create one with auth add)"}`);
  out(`   the guide: ${GUIDE_URL}`);
  out(`   e.g. "Read ${GUIDE_URL} and use it to operate my boof server at https://${hostname}."`);
  return 0;
}

function quote(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

async function status(
  root: string,
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  if (!existsSync(dataRootPaths(root).settings)) {
    err(
      `remote status: no settings.json in ${root}; nothing is configured yet (run: boof-runner remote setup)`,
    );
    return 1;
  }
  const raw = await readRawSettings(root);
  const settings = SettingsSchema.parse(raw);
  const sec = securitySettings(settings);
  const clients = await new AuthStore(root).list();
  const now = Date.now();
  const active = clients.filter(
    (c) => !c.revokedAt && !(c.expiresAt && Date.parse(c.expiresAt) <= now),
  ).length;
  const mode = await modeOf(root);
  out(`Data root:             ${root}`);
  out(`Auth mode:             ${sec.auth.mode}`);
  out(`Allowed hosts:         ${sec.allowedHosts.length ? sec.allowedHosts.join(", ") : "(none)"}`);
  out(
    `Allowed project roots: ${sec.allowedProjectRoots.length ? sec.allowedProjectRoots.join(", ") : "(none)"}`,
  );
  out(`Active clients:        ${active}`);
  out(
    `Data root permissions: ${mode === null ? "n/a" : mode.toString(8)}${mode !== null && mode & 0o077 ? " (accessible to other users; run: chmod 700)" : ""}`,
  );
  out(`Non-loopback bind:     ${await bindVerdict(root, settings)}`);
  return 0;
}

async function disable(
  root: string,
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  if (!existsSync(dataRootPaths(root).settings)) {
    err(`remote disable: no settings.json in ${root}; nothing to disable`);
    return 1;
  }
  const raw = await readRawSettings(root);
  await writeRawSettings(root, {
    ...raw,
    security: withAuthMode(securityBlock(raw), "local-trust"),
  });
  out('security.auth.mode is now "local-trust". Allowed hosts, roots and clients were kept.');
  out(
    "Existing keys still work for loopback clients; the server will refuse non-loopback binds until you run remote setup again.",
  );
  return 0;
}
