import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { McpStartError, runStdio } from "@boof-runner/mcp";
import { InvalidIdError, isKebabId } from "@boof-runner/shared";
import { scaffoldDataRoot } from "./scaffold.js";

export const MCP_HELP = `boof-runner mcp — serve boof over the Model Context Protocol on stdin/stdout

Usage:
  boof-runner mcp [-d <data>] [--client <id>] [--project <id>]

  -d, --data <path>   Data root (default: ./data, or $BOOF_RUNNER_DATA_ROOT)
      --client <id>   Act as this API client (see "auth list"); its scopes, project
                      restriction and trust apply. No key is needed: the OS user owns the data root.
                      Without --client the local admin principal is used, and only when
                      security.auth.mode is "local-trust"; otherwise the command refuses.
      --project <id>  Serve one project only: the projectId argument is hidden and filled in.

stdout carries the protocol only; logs go to stderr. Add it to Claude Code with:
  claude mcp add boof -- boof-runner mcp -d <data> --project <id>
Remote harnesses use the HTTP endpoint /mcp of "boof-runner serve" instead.`;

/** `mcp` subcommand. Returns a process exit code (only on a start error or help). */
export async function mcpCommand(
  argv: string[],
  defaultRoot: () => string,
  err: (line: string) => void = console.error,
  out: (line: string) => void = console.log,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        data: { type: "string", short: "d" },
        client: { type: "string" },
        project: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    err(`mcp: ${(e as Error).message}`);
    return 1;
  }
  const v = parsed.values;
  if (v.help) {
    out(MCP_HELP);
    return 0;
  }
  for (const [flag, id] of [
    ["--client", v.client],
    ["--project", v.project],
  ] as const) {
    if (id !== undefined && !isKebabId(id)) {
      err(`mcp: ${flag} must be a kebab-case id`);
      return 1;
    }
  }
  const root = v.data
    ? isAbsolute(v.data)
      ? v.data
      : resolve(process.cwd(), v.data)
    : defaultRoot();
  try {
    await scaffoldDataRoot(root);
    await runStdio({ root, client: v.client, project: v.project });
    return 0;
  } catch (e) {
    if (
      e instanceof McpStartError ||
      e instanceof InvalidIdError ||
      (e as { status?: number }).status === 404
    ) {
      err(`mcp: ${(e as Error).message}`);
      return 1;
    }
    throw e;
  }
}
