import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BrowserSessionStore, SettingsStore, securitySettings } from "@boof/heart";
import { beginCliAudit } from "./cli-audit.js";

export const OPEN_HELP = `boof-runner open — print a single-use link that signs a browser in to the web UI

Usage:
  boof-runner open [-d <data>] [--port <n>] [--host 127.0.0.1|localhost] [--revoke-all]

  -d, --data <path>   Data root (default: ./data, or $BOOF_RUNNER_DATA_ROOT)
      --port <n>      Port of the running server (default: $BOOF_RUNNER_PORT, then 4319)
      --host <addr>   127.0.0.1 (default) or localhost
      --revoke-all    Sign out every browser session and drop pending links

The link is valid for 10 minutes and works once. It is printed, never opened for you, because
process arguments are visible to other local users. Only someone who can already act as the
owner of the data root can mint one.`;

const DEFAULT_PORT = 4319;

/** `open` subcommand. Returns a process exit code. */
export async function openCommand(
  argv: string[],
  defaultRoot: () => string,
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        data: { type: "string", short: "d" },
        port: { type: "string" },
        host: { type: "string" },
        "revoke-all": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    err(`open: ${(e as Error).message}\n`);
    err(OPEN_HELP);
    return 1;
  }
  const v = parsed.values;
  if (v.help) {
    out(OPEN_HELP);
    return 0;
  }
  const portText = v.port ?? process.env.BOOF_RUNNER_PORT ?? String(DEFAULT_PORT);
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    err(`open: the port must be a number from 1 to 65535 (got "${portText}")`);
    return 1;
  }
  const host = v.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    err("open: --host must be 127.0.0.1 or localhost (sign-in links work on loopback only)");
    return 1;
  }
  const root = v.data
    ? isAbsolute(v.data)
      ? v.data
      : resolve(process.cwd(), v.data)
    : defaultRoot();

  const revoke = v["revoke-all"] === true;
  const audit = beginCliAudit(root, revoke ? "cli:open.revoke-all" : "cli:open");
  try {
    const store = new BrowserSessionStore(root);
    if (revoke) {
      const n = await store.revokeAll();
      await audit.ok();
      out(`Signed out ${n} browser session(s).`);
      return 0;
    }
    const sec = securitySettings(await new SettingsStore(root).load());
    if (sec.auth.mode === "required") {
      await audit.failCode("auth_required");
      err(
        'open: security.auth.mode is "required": the web UI uses an API key (paste one created with "boof-runner auth add").',
      );
      return 1;
    }
    const { code } = await store.createLink();
    await audit.ok();
    out("Sign in to the boof web UI (single use, valid for 10 minutes):");
    out(`  http://${host}:${port}/auth/browser?code=${code}`);
    return 0;
  } catch (e) {
    await audit.fail(e);
    err(`open: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
