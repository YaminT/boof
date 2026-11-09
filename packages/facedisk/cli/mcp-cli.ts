import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { McpStartError, mcpNeedsClientMessage, runStdio } from "@boof/heart-server";
import type { ToolCatalog } from "@boof/heart";
import { InvalidIdError, isKebabId, scaffoldDataRoot } from "@boof/heart";

export const MCP_HELP = `boof-runner mcp — serve boof over the Model Context Protocol on stdin/stdout

Usage:
  boof-runner mcp [-d <data>] --client <id> [--project <id>]

  -d, --data <path>   Data root (default: ./data, or $BOOF_RUNNER_DATA_ROOT)
      --client <id>   Act as this API client (see "auth list"); its scopes, project
                      restriction and trust apply. No key is needed: the OS user owns the data root.
                      Required. Keyless MCP was removed (agent containment).
      --project <id>  Serve one project only: the projectId argument is hidden and filled in; the
                      API-client and webhook tools are hidden too.

stdout carries the protocol only; logs go to stderr. Add it to Claude Code with:
  claude mcp add boof -- boof-runner mcp -d <data> --client <id> --project <id>
Remote harnesses use the HTTP endpoint /mcp of "boof-runner serve" instead.`;

/** `mcp` subcommand. Returns a process exit code (only on a start error or help). */
export async function mcpCommand(
  argv: string[],
  defaultRoot: () => string,
  catalog: ToolCatalog,
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
        admin: { type: "boolean" },
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
  const root = v.data
    ? isAbsolute(v.data)
      ? v.data
      : resolve(process.cwd(), v.data)
    : defaultRoot();
  try {
    // `--admin` is parsed only so the removal can name the replacement. Any use is a refusal.
    if (v.admin) {
      throw new McpStartError(
        'boof-runner mcp: --admin was removed. Create a trusted client with the admin scope ("boof-runner auth add --name mcp-admin --scopes admin --trust trusted") and pass --client <id>.',
        3,
      );
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
    if (v.client === undefined) throw new McpStartError(mcpNeedsClientMessage(), 3);
    // A client lives in the data root, so a missing root has none: refuse before creating it.
    if (!existsSync(root)) {
      throw new McpStartError(
        `unknown client "${v.client}": no boof data root at ${root}; pass -d <data root>`,
        3,
        false,
      );
    }
    await scaffoldDataRoot(root);
    await runStdio({ root, catalog, client: v.client, project: v.project });
    return 0;
  } catch (e) {
    if (e instanceof McpStartError) {
      // The refusal copy is printed as is. Other start errors keep the `mcp:` prefix.
      err(e.rawMessage ? e.message : `mcp: ${e.message}`);
      return e.exitCode;
    }
    if (e instanceof InvalidIdError || (e as { status?: number }).status === 404) {
      err(`mcp: ${(e as Error).message}`);
      return 1;
    }
    throw e;
  }
}
