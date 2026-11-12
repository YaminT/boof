import { execCommand, findExecutable, type FindExecutableOptions } from "@boof/heart";
import type { InstallResult } from "@boof/heart";
import { agentEnv } from "../agent-env.js";

export interface InstallCheckOptions extends FindExecutableOptions {
  /** `--version` timeout; default 8 s. */
  timeoutMs?: number;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** The first non-empty line of version output, without colour codes. */
export function cleanVersion(output: string): string | undefined {
  const line = output
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return line || undefined;
}

/**
 * Free "is it installed" check for a command-line agent: find the program on PATH, then in the
 * known install locations, then ask it for `--version`. It never sends a prompt: `--version` is
 * the only argument the program ever receives.
 */
export async function checkInstalled(
  bin: string,
  opts: InstallCheckOptions = {},
): Promise<InstallResult> {
  const found = await findExecutable(bin, opts);
  if (!found) return { installed: false, message: `\`${bin}\` not found on PATH` };
  const res = await execCommand(found.path, ["--version"], {
    launch: { kind: "direct" },
    cwd: process.cwd(),
    timeoutMs: opts.timeoutMs ?? 8000,
    env: agentEnv(),
  });
  const base = { path: found.path, ...(found.offPath ? { foundOffPath: found.path } : {}) };
  if (res.timedOut) {
    return { installed: false, ...base, message: `\`${bin} --version\` did not answer` };
  }
  if (res.code !== 0) {
    return { installed: false, ...base, message: `\`${bin} --version\` exited ${res.code}` };
  }
  const version = cleanVersion(res.stdout) ?? cleanVersion(res.stderr);
  return {
    installed: true,
    ...base,
    ...(version ? { version } : {}),
    message: found.offPath
      ? `found at ${found.path}, which is not on PATH`
      : `installed${version ? ` (${version})` : ""}`,
  };
}
