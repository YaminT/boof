import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type AgentSdk = Pick<typeof import("@anthropic-ai/claude-agent-sdk"), "query">;

type Importer = () => Promise<unknown>;
type ExecutableResolverDeps = {
  requireResolve?: (specifier: string) => string;
  sdkResolve?: (specifier: string) => string;
  report?: () => { header?: { glibcVersionRuntime?: string } } | undefined;
  platform?: NodeJS.Platform;
  arch?: string;
  musl?: boolean;
};

const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);

export async function loadAgentSdk(importer?: Importer): Promise<AgentSdk> {
  try {
    return (await (importer ? importer() : import("@anthropic-ai/claude-agent-sdk"))) as AgentSdk;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error("the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) is not installed");
    }
    throw new Error("the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) failed to load");
  }
}

function isExecutable(path: string, platform = process.platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
  } catch {
    return false;
  }
  if (platform === "win32") return existsSync(path);
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
): Promise<{ path: string | undefined; source: "env" | "sdk" | "path" | null; reason?: string }> {
  const configured = env.BOOF_RUNNER_CLAUDE_AGENT_BIN;
  if (configured) {
    const absolute = resolve(configured);
    if (isExecutable(absolute, deps.platform)) return { path: absolute, source: "env" };
    return {
      path: undefined,
      source: null,
      reason: "BOOF_RUNNER_CLAUDE_AGENT_BIN is not executable",
    };
  }

  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  if (platform === "win32" || platform === "darwin" || platform === "linux") {
    let musl = false;
    if (platform === "linux") {
      if (deps.musl !== undefined) musl = deps.musl;
      else {
        const report = deps.report
          ? deps.report()
          : (process.report?.getReport() as
              { header?: { glibcVersionRuntime?: string } } | undefined);
        musl = !!report && !report.header?.glibcVersionRuntime;
      }
    }
    const variants = platform === "linux" ? (musl ? ["-musl", ""] : ["", "-musl"]) : [""];
    try {
      const sdkEntry = (deps.sdkResolve ?? ((specifier) => require.resolve(specifier)))(
        "@anthropic-ai/claude-agent-sdk",
      );
      const sdkRequire = createRequire(sdkEntry);
      for (const variant of variants) {
        const packageName = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}${variant}`;
        try {
          const binary = (deps.requireResolve ?? ((specifier) => sdkRequire.resolve(specifier)))(
            `${packageName}/${platform === "win32" ? "claude.exe" : "claude"}`,
          );
          if (existsSync(binary)) return { path: undefined, source: "sdk" };
        } catch {
          // Try the other libc variant, then PATH.
        }
      }
    } catch {
      // SDK itself is absent; PATH can still supply a CLI.
    }
  }

  const bin = env.BOOF_RUNNER_CLAUDE_BIN ?? "claude";
  const pathValue = env.PATH ?? env.Path ?? "";
  const pathDirs = pathValue.split(platform === "win32" ? ";" : ":");
  const extensions =
    platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  const hasPathSeparator = bin.includes("/") || bin.includes("\\");
  const alreadyHasExtension =
    platform === "win32" &&
    extensions.some((extension) => bin.toLowerCase().endsWith(extension.toLowerCase()));
  const suffixes = alreadyHasExtension ? [""] : extensions;
  const candidates =
    isAbsolute(bin) || hasPathSeparator
      ? suffixes.map((extension) => resolve(`${bin}${extension}`))
      : pathDirs.flatMap((dir) =>
          suffixes.map((extension) => join(dir || process.cwd(), `${bin}${extension}`)),
        );
  const path = candidates.find((candidate) => isExecutable(candidate, platform));
  if (path) return { path: resolve(path), source: "path" };
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
