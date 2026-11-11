import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  AuthStore,
  BackupError,
  isExpired,
  SettingsStore,
  backupDataRoot,
  restoreDataRoot,
} from "@boof/heart";
import { beginCliAudit } from "./cli-audit.js";

export const BACKUP_HELP = `boof-runner backup — copy a data root to a tar.gz archive

Usage:
  boof-runner backup --out <file.tar.gz> [-d <root>] [--live] [--no-secrets]

  -d, --data <path>   Data root (default: ./data, or $BOOF_RUNNER_DATA_ROOT)
      --out <file>    New archive file, created with mode 0600. Not overwritten
      --live          Copy while a runner or server holds the root. Task files are
                      copied under their task locks. Without --live, a live runner
                      or server refuses the backup
      --no-secrets    Leave out credentials, sessions, private agent data and secrets

The archive holds manifest.json (boof version, schema version, sha256 of each file)
and the data root under root/. Worktrees are not included, and neither are lock
files. A symbolic link inside the root is skipped, not followed.`;

export const RESTORE_HELP = `boof-runner restore — restore a backup into an empty directory

Usage:
  boof-runner restore --from <file.tar.gz> -d <directory>

      --from <file>   Archive written by boof-runner backup
  -d, --data <path>   Empty or missing directory. Required

The manifest hashes detect accidental corruption; they do not detect tampering.
Restore only archives you created and trust. An archive is trusted configuration:
it can restore project roots, commands, webhooks and other settings. A schema newer
than this boof-runner is refused. An older schema is migrated. Restored files are
private (0600) and directories are private (0700).`;

/** `backup` subcommand. Returns a process exit code. */
export async function backupCommand(
  argv: string[],
  defaultRoot: () => string,
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
): Promise<number> {
  const parsed = parseCommand("backup", argv, BACKUP_HELP, err);
  if (parsed === "help") {
    out(BACKUP_HELP);
    return 0;
  }
  if (parsed === "bad") return 1;
  if (parsed.values.help) {
    out(BACKUP_HELP);
    return 0;
  }
  const outFile = parsed.values.out;
  if (!outFile) {
    err("backup: pass --out <file.tar.gz>");
    return 1;
  }
  const root = resolve(parsed.values.data ?? defaultRoot());
  if (!existsSync(root)) {
    err(`backup: no data root at ${root}`);
    return 1;
  }
  try {
    const result = await backupDataRoot(root, resolve(outFile), {
      live: parsed.values.live === true,
      noSecrets: parsed.values["no-secrets"] === true,
    });
    for (const line of result.skipped) err(`backup: skipped ${line}`);
    out(`Wrote ${result.files} files to ${resolve(outFile)}`);
    if (parsed.values["no-secrets"] !== true) {
      err(
        "backup: archive contains API keys and signing secrets in plaintext; store it like a password",
      );
    }
    await auditIfLoadable(root, "cli:backup", true);
    return 0;
  } catch (e) {
    await auditIfLoadable(root, "cli:backup", false, e);
    err(`backup: ${oneLine(e)}`);
    return 1;
  }
}

/** `restore` subcommand. Returns a process exit code. `-d` is required. */
export async function restoreCommand(
  argv: string[],
  _defaultRoot: () => string,
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
): Promise<number> {
  const parsed = parseCommand("restore", argv, RESTORE_HELP, err);
  if (parsed === "help") {
    out(RESTORE_HELP);
    return 0;
  }
  if (parsed === "bad") return 1;
  if (parsed.values.help) {
    out(RESTORE_HELP);
    return 0;
  }
  const from = parsed.values.from;
  if (!from) {
    err("restore: pass --from <file.tar.gz>");
    return 1;
  }
  if (!parsed.values.data) {
    err("restore: pass -d <empty directory>");
    return 1;
  }
  const dest = resolve(parsed.values.data);
  try {
    err(
      "restore: only restore archives you created and trust; hashes detect corruption, not tampering",
    );
    await restoreDataRoot(resolve(from), dest);
    out(`Restored ${dest}`);
    // The data is restored and valid from here on: nothing below may turn this into a failure.
    await auditIfLoadable(dest, "cli:restore", true);
    if (existsSync(join(dest, "auth"))) {
      out(
        "Restore notice: API clients and browser sessions that were revoked after this backup come back from this archive.",
      );
      try {
        const now = Date.now();
        const active = (await new AuthStore(dest).list()).filter(
          (client) => !client.revokedAt && !isExpired(client, now),
        );
        out(
          `Restored active API clients: ${active.length ? active.map((client) => `${printable(client.name)} (${printable(client.id)})`).join(", ") : "none"}`,
        );
      } catch (e) {
        err(`restore: warning: could not read auth/clients.json: ${oneLine(e)}`);
      }
      out(
        "Revoke any client you no longer trust with `boof-runner auth revoke <id> -d <dir>`, and sign out every restored browser session with `boof-runner open --revoke-all -d <dir>`. Rotate webhook, n8n and owlish keys that were rotated after this backup.",
      );
    }
    return 0;
  } catch (e) {
    err(`restore: ${oneLine(e)}`);
    return 1;
  }
}

function parseCommand(
  name: "backup" | "restore",
  argv: string[],
  help: string,
  err: (line: string) => void,
):
  | "help"
  | "bad"
  | {
      values: {
        data?: string;
        out?: string;
        from?: string;
        live?: boolean;
        "no-secrets"?: boolean;
        help?: boolean;
      };
    } {
  // A lone --help is handled before parseArgs so an unknown flag beside it still prints help.
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return "help";
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        data: { type: "string", short: "d" },
        out: { type: "string" },
        from: { type: "string" },
        live: { type: "boolean" },
        "no-secrets": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    return { values: parsed.values };
  } catch (e) {
    err(`${name}: ${oneLine(e)}`);
    err(help);
    return "bad";
  }
}

/** Audit only when settings load. A schema this release cannot read must not print a second error. */
async function auditIfLoadable(
  root: string,
  action: string,
  ok: boolean,
  failure?: unknown,
): Promise<void> {
  if (!existsSync(root)) return;
  try {
    await new SettingsStore(root).load();
  } catch {
    return;
  }
  const audit = beginCliAudit(root, action);
  if (ok) await audit.ok();
  else await audit.fail(failure ?? new BackupError("error"));
}

function oneLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return printable(message.replace(/[\r\n]+/g, " "));
}

/** Escape control characters (terminal escapes, bells) so archive-supplied text cannot rewrite the screen. */
function printable(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f]/g,
    (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}
