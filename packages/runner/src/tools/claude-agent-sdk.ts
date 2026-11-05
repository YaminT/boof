import { accessSync, constants, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { commandExists } from "@boof/heart";

export type AgentSdk = Pick<typeof import("@anthropic-ai/claude-agent-sdk"), "query">;

type Importer = () => Promise<unknown>;
type ExecutableResolverDeps = {
  requireResolve?: (specifier: string) => string;
  commandExists?: (command: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
  arch?: string;
  musl?: boolean;
};

const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);

export async function loadAgentSdk(importer?: Importer): Promise<AgentSdk> {
  try {
    return (await (importer ? importer() : import("@anthropic-ai/claude-agent-sdk"))) as AgentSdk;
  } catch {
    throw new Error("the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) is not installed");
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveClaudeAgentExecutable(
  env: NodeJS.ProcessEnv = process.env,
  deps: ExecutableResolverDeps = {},
): Promise<{ path: string | undefined; source: "env" | "sdk" | "path" | null }> {
  const configured = env.BOOF_RUNNER_CLAUDE_AGENT_BIN;
  if (configured && isExecutable(configured)) return { path: configured, source: "env" };

  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const report = process.report?.getReport() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  const musl = deps.musl ?? (platform === "linux" && !report?.header?.glibcVersionRuntime);
  const platformName = platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux";
  const suffix = platformName === "linux" && musl ? "-musl" : "";
  try {
    (deps.requireResolve ?? ((specifier) => require.resolve(specifier)))(
      `@anthropic-ai/claude-agent-sdk-${platformName}-${arch}${suffix}/package.json`,
    );
    return { path: undefined, source: "sdk" };
  } catch {
    // The CLI can still use a separately installed Claude Code executable.
  }

  const bin = env.BOOF_RUNNER_CLAUDE_BIN ?? "claude";
  if (await (deps.commandExists ?? commandExists)(bin)) return { path: undefined, source: "path" };
  return { path: undefined, source: null };
}

function readSdkVersion(): string {
  try {
    const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const manifest = JSON.parse(readFileSync(join(dirname(sdkEntry), "package.json"), "utf8")) as {
      version?: string;
    };
    return manifest.version ?? "0.3.318";
  } catch {
    return "0.3.318";
  }
}

export const SDK_VERSION = readSdkVersion();
