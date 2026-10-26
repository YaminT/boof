import { readFileSync, realpathSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerEngine } from "@boof-runner/runner";
import { startServer } from "@boof-runner/web";
import { scaffoldDataRoot } from "./scaffold.js";
import { RunnerGuard } from "./runner-guard.js";
import { authCommand } from "./auth-cli.js";
import { remoteCommand } from "./remote-cli.js";
import { serviceCommand } from "./service-cli.js";
import { projectCommand } from "./project-cli.js";
import { planCommand } from "./plan-cli.js";
import { mcpCommand } from "./mcp-cli.js";
import { drainQueue, ProjectResolutionError, runTask, scanRepoToTasks } from "./headless.js";
import { MigrationError } from "@boof-runner/shared";

interface ServeArgs {
  dataRoot: string;
  port: number;
  noRunner: boolean;
  host: string;
  tlsCert?: string;
  tlsKey?: string;
}

function defaultDataRoot(): string {
  return process.env.BOOF_RUNNER_DATA_ROOT ?? resolve(process.cwd(), "data");
}

function absPath(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/** Pull `--flag value` / `--flag=value` out of an arg list. */
function getOpt(argv: string[], names: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    for (const n of names) {
      if (a === n) return argv[i + 1];
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return undefined;
}

function hasFlag(argv: string[], names: string[]): boolean {
  return argv.some((a) => names.includes(a));
}

const HELP = `boof-runner — Agent Task Runner

Usage:
  boof-runner [serve] [options]        Start the web UI + background runner (default)
  boof-runner run <prompt> [options]   Enqueue a prompt and drive it to completion (headless)
  boof-runner run --file <path> [...]  Same, reading the prompt from a file
  boof-runner run --all [options]      Drive the pending queue of every project to completion
  boof-runner scan <repo> [options]    Turn a repo's not-done goal.boof.xml units into tasks
  boof-runner project <add|list|remove>  Manage projects (git repositories) served by this data root
  boof-runner plan <import|sync|export>  Import a repo's goal files into a plan, sync it to tasks, export XML (see: plan --help)
  boof-runner auth <add|list|revoke|rotate>  Manage API clients for remote access (see: auth --help)
  boof-runner remote <setup|status|disable>  Expose this server to a remote AI harness in one command (see: remote --help)
  boof-runner service <install|uninstall|status|logs>  Run boof-runner as a systemd user service on Linux (see: service --help)
  boof-runner mcp [options]            Serve boof over MCP on stdin/stdout for an agent host (see: mcp --help)
  boof-runner --help                   Show this help

Common options:
  -d, --data <path>   Data root directory (default: ./data, or $BOOF_RUNNER_DATA_ROOT)

serve options:
  -p, --port <n>      Web server port (default: 4319, or $BOOF_RUNNER_PORT)
      --no-runner     Start the web server only (do not start the runner)
      --host <addr>   Bind address (default: 127.0.0.1, or $BOOF_RUNNER_HOST). Non-loopback needs
                      security.auth.mode = "required" and at least one client (auth add)
      --tls-cert <f>  PEM certificate; with --tls-key serves HTTPS
      --tls-key <f>   PEM private key

run options:
  -f, --file <path>   Read the prompt from a file instead of an argument
      --all           Drive all pending tasks (every project, or --project) instead of a new prompt
      --project <id>  Project to queue the task in (or to drain with --all)
      --repo <dir>    Repository to run against; its project is looked up by real path and
                      registered (its id printed) when unknown. Default: the default project
      --base <ref>    Branch or commit the task's worktree starts from (default: HEAD)
      --title <text>  Task title (default: first line of the prompt)
      --tool <id>     Force all roles to this tool (e.g. mock, claude-code, codex, opencode)
      --model <name>  Model for --tool
      --runs <n>      Run the pipeline N times for the task (default 1)

scan options:
      --project <id>  Project the tasks go to (default: the project of <repo>, registered if needed)
      --dry-run       List the units that would become tasks; create nothing
      --bump <s>      Status to record on success: review | done (default done)
      --tool <id>     Force all roles to this tool for the created tasks
      --model <name>  Model for --tool

Exit codes: 0 success; 1 a task failed / parked / nothing actionable / bad usage.`;

/** Locate the built UI directory shipped alongside this CLI, if present. */
function resolveUiDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // From bin/dist or bin/src → ../../packages/web/ui/dist
  return resolve(here, "..", "..", "packages", "web", "ui", "dist");
}

/** Version from the package.json two levels above bin/src or bin/dist. */
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(here, "..", "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function parseServeArgs(argv: string[]): ServeArgs {
  const dataOpt = getOpt(argv, ["--data", "-d"]);
  const portOpt = getOpt(argv, ["--port", "-p"]);
  return {
    dataRoot: dataOpt ? absPath(dataOpt) : defaultDataRoot(),
    port: Number(portOpt ?? process.env.BOOF_RUNNER_PORT ?? 4319),
    noRunner: hasFlag(argv, ["--no-runner"]),
    host: getOpt(argv, ["--host"]) ?? process.env.BOOF_RUNNER_HOST ?? "127.0.0.1",
    tlsCert: getOpt(argv, ["--tls-cert"]),
    tlsKey: getOpt(argv, ["--tls-key"]),
  };
}

/** The original behavior: scaffold data, boot the web UI + background runner. */
export async function serve(argv: string[]): Promise<void> {
  const args = parseServeArgs(argv);
  const root = args.dataRoot;
  const { created } = await scaffoldDataRoot(root);
  console.log(`${created ? "Scaffolded" : "Using"} data root: ${root}`);

  const uiDir = resolveUiDir();
  let running;
  let engine: RunnerEngine | null = null;
  try {
    running = await startServer({
      root,
      port: args.port,
      host: args.host,
      uiDir,
      version: readVersion(),
      runnerRunning: () => engine !== null,
      tlsCert: args.tlsCert ? absPath(args.tlsCert) : undefined,
      tlsKey: args.tlsKey ? absPath(args.tlsKey) : undefined,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const scheme = args.tlsCert ? "https" : "http";
  const shown = args.host === "0.0.0.0" || args.host === "::" ? "localhost" : args.host;
  const hostPart = shown.includes(":") && !shown.startsWith("[") ? `[${shown}]` : shown;
  console.log(`Web UI:  ${scheme}://${hostPart}:${running.port}`);
  console.log(`API:     ${scheme}://${hostPart}:${running.port}/api`);

  const guard = new RunnerGuard(root);
  if (!args.noRunner) {
    if (await guard.acquire()) {
      engine = new RunnerEngine({ root });
      console.log("Runner:  started (toggle on/off in the UI)");
      void engine.loop();
    } else {
      console.log("Runner:  already running in another process — not starting a second one");
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.log(`\n${signal} again: exiting now`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`\nShutting down (${signal})…`);
    const graceMs = Number(process.env.BOOF_RUNNER_SHUTDOWN_GRACE_MS ?? 30_000);
    if (engine) {
      const { stopped, timedOut } = await engine.shutdown(graceMs);
      if (stopped.length > 0) console.log(`Stopped running task(s): ${stopped.join(", ")}`);
      if (timedOut) console.log(`Grace period of ${graceMs} ms elapsed; exiting anyway`);
    }
    await guard.release();
    await running.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/** `run` subcommand. Returns a process exit code. */
export async function runCommand(argv: string[]): Promise<number> {
  const dataOpt = getOpt(argv, ["--data", "-d"]);
  const root = dataOpt ? absPath(dataOpt) : defaultDataRoot();
  const repo = getOpt(argv, ["--repo"]);
  const tool = getOpt(argv, ["--tool"]);
  const model = getOpt(argv, ["--model"]);
  const base = getOpt(argv, ["--base"]);
  const title = getOpt(argv, ["--title"]);
  const project = getOpt(argv, ["--project"]);

  if (hasFlag(argv, ["--all"])) {
    const { failed } = await drainQueue({ root, ...(project ? { project } : {}) });
    return failed > 0 ? 1 : 0;
  }

  const file = getOpt(argv, ["--file", "-f"]);
  const prompt = file ? await readFileAsync(absPath(file), "utf8") : firstPositional(argv);
  if (!prompt || !prompt.trim()) {
    console.error("run: a prompt is required (pass text, --file <path>, or --all).\n");
    console.error(HELP);
    return 1;
  }

  const runsOpt = getOpt(argv, ["--runs"]);
  const summary = await runTask({
    root,
    prompt,
    ...(project ? { project } : {}),
    ...(repo ? { repo } : {}),
    ...(base ? { base } : {}),
    ...(title ? { title } : {}),
    ...(tool ? { tool } : {}),
    ...(model ? { model } : {}),
    ...(runsOpt ? { runs: Number(runsOpt) } : {}),
  });
  return summary.ok ? 0 : 1;
}

/** `scan` subcommand. Returns a process exit code. */
export async function scanCommand(argv: string[]): Promise<number> {
  const repo = firstPositional(argv);
  if (!repo) {
    console.error("scan: a target repo path is required.\n");
    console.error(HELP);
    return 1;
  }
  const dataOpt = getOpt(argv, ["--data", "-d"]);
  const bump = getOpt(argv, ["--bump"]);
  const tool = getOpt(argv, ["--tool"]);
  const model = getOpt(argv, ["--model"]);
  const project = getOpt(argv, ["--project"]);
  const summary = await scanRepoToTasks({
    root: dataOpt ? absPath(dataOpt) : defaultDataRoot(),
    repo,
    ...(project ? { project } : {}),
    dryRun: hasFlag(argv, ["--dry-run"]),
    bumpTo: bump === "review" ? "review" : bump === "done" ? "done" : undefined,
    ...(tool ? { tool } : {}),
    ...(model ? { model } : {}),
  });
  void summary;
  return 0;
}

/** First token that is not a flag and not consumed as an option value. */
export function firstPositional(argv: string[]): string | undefined {
  const valueOpts = new Set([
    "--data",
    "-d",
    "--file",
    "-f",
    "--repo",
    "--project",
    "--base",
    "--title",
    "--tool",
    "--model",
    "--runs",
    "--bump",
    "--port",
    "-p",
    "--host",
    "--tls-cert",
    "--tls-key",
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (valueOpts.has(a)) {
      i += 1; // skip its value
      continue;
    }
    if (a.startsWith("-")) continue; // some other flag (or --opt=value)
    return a;
  }
  return undefined;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [cmd, ...rest] = argv;
  // Top-level --help (but let `run`/`scan --help` fall through to their handlers).
  if (
    hasFlag(argv, ["--help", "-h"]) &&
    cmd !== "run" &&
    cmd !== "scan" &&
    cmd !== "auth" &&
    cmd !== "remote" &&
    cmd !== "service" &&
    cmd !== "plan" &&
    cmd !== "project" &&
    cmd !== "mcp"
  ) {
    console.log(HELP);
    return;
  }
  let code = 0;
  try {
    code = await dispatch(cmd, rest, argv);
  } catch (err) {
    if (err instanceof ProjectResolutionError || err instanceof MigrationError) {
      console.error(err.message);
      code = 1;
    } else {
      throw err;
    }
  }
  if (code === SERVE_FOREVER) return;
  if (code !== 0) process.exitCode = code;
}

/** Sentinel: the command (serve) keeps the process alive; main must not set an exit code. */
const SERVE_FOREVER = -1;

async function dispatch(cmd: string | undefined, rest: string[], argv: string[]): Promise<number> {
  let code = 0;
  switch (cmd) {
    case "run":
      if (hasFlag(rest, ["--help", "-h"])) console.log(HELP);
      else code = await runCommand(rest);
      break;
    case "scan":
      if (hasFlag(rest, ["--help", "-h"])) console.log(HELP);
      else code = await scanCommand(rest);
      break;
    case "auth":
      code = await authCommand(rest, defaultDataRoot);
      break;
    case "remote":
      code = await remoteCommand(rest, defaultDataRoot);
      break;
    case "service":
      code = await serviceCommand(rest, defaultDataRoot);
      break;
    case "plan":
      code = await planCommand(rest, defaultDataRoot);
      break;
    case "project":
      code = await projectCommand(rest, defaultDataRoot);
      break;
    case "mcp":
      code = await mcpCommand(rest, defaultDataRoot);
      break;
    case "serve":
      await serve(rest);
      return SERVE_FOREVER; // serve runs forever
    case undefined:
      await serve([]);
      return SERVE_FOREVER;
    default:
      // Unknown first token → treat the whole invocation as serve options so
      // existing `boof-runner -d ... -p ...` usage keeps working.
      await serve(argv);
      return SERVE_FOREVER;
  }
  return code;
}

// Run when invoked directly (not when imported by tests). Resolve symlinks so a
// globally-installed `boof-runner` shim still matches this module's real path.
const entryPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
const selfPath = fileURLToPath(import.meta.url);
const invokedDirectly =
  entryPath === selfPath || entryPath.endsWith(join("bin", "src", "boof-runner.ts"));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
