import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { McpStartError, runStdio } from "@boof-runner/mcp";
import type { ToolCatalog } from "@boof-runner/shared";
import { InvalidIdError, isKebabId, scaffoldDataRoot } from "@boof-runner/shared";

export const MCP_HELP = `boof-runner mcp — serve boof over the Model Context Protocol on stdin/stdout

Usage:
  boof-runner mcp [-d <data>] [--client <id>] [--project <id>] [--admin]

  -d, --data <path>   Data root (default: ./data, or $BOOF_RUNNER_DATA_ROOT)
      --client <id>   Act as this API client (see "auth list"); its scopes, project
                      restriction and trust apply. No key is needed: the OS user owns the data root.
                      Without --client the server is the review-trust "local-mcp"
                      principal (drafts a human approves, own work only), and only when
                      security.auth.mode is "local-trust"; otherwise the command refuses.
      --project <id>  Serve one project only: the projectId argument is hidden and filled in; the
                      API-client and webhook tools are hidden too.
      --admin         Without --client: act as the local administrator and list the administration
                      tools (API clients, webhooks, settings writes, command templates, project
                      deletion). Without it they are hidden and the review-trust rules apply,
                      because an agent host that registers this server would otherwise hold
                      them. Not allowed with --client: the client's scopes decide.

stdout carries the protocol only; logs go to stderr. Add it to Claude Code with:
  claude mcp add boof -- boof-runner mcp -d <data> --project <id>
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
  for (const [flag, id] of [
    ["--client", v.client],
    ["--project", v.project],
  ] as const) {
    if (id !== undefined && !isKebabId(id)) {
      err(`mcp: ${flag} must be a kebab-case id`);
      return 1;
    }
  }
  if (v.admin && v.client !== undefined) {
    err("mcp: --admin applies only without --client (with --client the client's scopes decide)");
    return 1;
  }
  const root = v.data
    ? isAbsolute(v.data)
      ? v.data
      : resolve(process.cwd(), v.data)
    : defaultRoot();
  try {
    await scaffoldDataRoot(root);
    await runStdio({ root, catalog, client: v.client, project: v.project, admin: v.admin });
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
