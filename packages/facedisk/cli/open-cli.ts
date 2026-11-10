import { existsSync, statSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  BrowserSessionStore,
  openLoopbackRefusal,
  SettingsStore,
  securitySettings,
} from "@boof/heart";
import { beginCliAudit } from "./cli-audit.js";
import { migrateOldRoot } from "./migrate-old-root.js";

export const OPEN_HELP = `boof-runner open — print a single-use link that signs a browser in to the web UI

Usage:
  boof-runner open [-d <data>] [--port <n>] [--host 127.0.0.1|localhost|::1] [--revoke-all]

  -d, --data <path>   Data root (default: ./data, or $BOOF_RUNNER_DATA_ROOT)
      --port <n>      Port of the running server (default: $BOOF_RUNNER_PORT, then 4319)
      --host <addr>   127.0.0.1 (default), localhost or ::1
      --revoke-all    Sign out every browser session and drop pending links

The link is valid for 10 minutes, works once and only on the port it was minted for. It is printed, never opened for you, because
process arguments are visible to other local users. Only someone who can already act as the
owner of the data root can mint one.`;

const DEFAULT_PORT = 4319;

/** Best effort: does anything accept a TCP connection on this loopback port? */
export function defaultPortProbe(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (up: boolean) => {
      socket.destroy();
      done(up);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** `open` subcommand. Returns a process exit code. */
export async function openCommand(
  argv: string[],
  defaultRoot: () => string,
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
  portProbe: (host: string, port: number) => Promise<boolean> = defaultPortProbe,
  /** Linux: one-line refusal when another uid holds the port. Other platforms return null. */
  listenerRefusal: (host: string, port: number) => string | null = openLoopbackRefusal,
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
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    err("open: --host must be 127.0.0.1, localhost or ::1 (sign-in links work on loopback only)");
    return 1;
  }
  const root = resolve(process.cwd(), v.data ?? defaultRoot());
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    err(`open: no boof data root at ${root}; pass -d <data root>`);
    return 1;
  }

  const revoke = v["revoke-all"] === true;
  const audit = beginCliAudit(root, revoke ? "cli:open.revoke-all" : "cli:open");
  try {
    // Migrate before load(). A 0.3.0 settings file would otherwise surface as a raw schema error.
    await migrateOldRoot(root);
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
    const held = listenerRefusal(host, port);
    if (held) {
      await audit.failCode("listener_not_owner");
      err(`open: ${held}`);
      return 1;
    }
    const { code } = await store.createLink({ port });
    await audit.ok();
    if (v.port === undefined && process.env.BOOF_RUNNER_PORT === undefined) {
      const up = await portProbe(host === "localhost" ? "127.0.0.1" : host, port).catch(() => true);
      if (!up) {
        err(
          `open: nothing answers on ${host}:${port}. The link only works on port ${port}; if the server uses another port, run "boof-runner open --port <n>".`,
        );
      }
    }
    out("Sign in to the boof web UI (single use, valid for 10 minutes):");
    out(`  http://${host === "::1" ? "[::1]" : host}:${port}/auth/browser?code=${code}`);
    return 0;
  } catch (e) {
    await audit.fail(e);
    err(`open: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
