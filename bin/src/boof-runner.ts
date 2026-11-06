import { readFileSync, realpathSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ToolRegistry } from "@boof/runner";
import { boot, isRunnerStartFailure } from "@boof/boof/boot";
import { RunnerGuard } from "./runner-guard.js";
import { authCommand } from "@boof/facedisk/cli/auth-cli.js";
import { remoteCommand } from "@boof/facedisk/cli/remote-cli.js";
import { serviceCommand } from "@boof/facedisk/cli/service-cli.js";
import { TaskService } from "@boof/heart-server";
import { epicCommand } from "@boof/facedisk/cli/epic-cli.js";
import {
  HAND_WRITTEN_COMMANDS,
  isOpArea,
  matchOpCommand,
  opsCommand,
} from "@boof/facedisk/cli/ops-cli.js";
import { projectCommand } from "@boof/facedisk/cli/project-cli.js";
import { taskCommand } from "@boof/facedisk/cli/task-cli.js";
import { planCommand } from "@boof/facedisk/cli/plan-cli.js";
import { mcpCommand } from "@boof/facedisk/cli/mcp-cli.js";
import { drainQueue, runTask, scanRepoToTasks } from "./headless.js";
import { MigrationError, scaffoldDataRoot, ProjectResolutionError } from "@boof/heart";
import { beginCliAudit, writeInterruptedSync } from "@boof/facedisk/cli/cli-audit.js";

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
  boof-runner epic <add|list|archive|remove>  Manage a project's epics, named groups of tasks (see: epic --help)
  boof-runner task <list|move>         List tasks with epics and subtasks, move a task (see: task --help)
  boof-runner plan <import|sync|export>  Import a repo's goal files into a plan, sync it to tasks, export XML (see: plan --help)
  boof-runner auth <add|list|revoke|rotate>  Manage API clients for remote access (see: auth --help)
  boof-runner remote <setup|status|disable>  Expose this server to a remote AI harness in one command (see: remote --help)
  boof-runner service <install|uninstall|status|logs>  Run boof-runner as a systemd user service on Linux (see: service --help)
  boof-runner mcp [options]            Serve boof over MCP on stdin/stdout for an agent host (see: mcp --help)
  boof-runner ops                      List the operation commands (every REST/MCP operation)
  boof-runner <area> <verb> [flags]    Run one operation, e.g. tasks create --project <id> --title <t> (see: <area> <verb> --help)
  boof-runner --help                   Show this help
  boof-runner --version                Print the version (also: -v)

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
      --epic <id>     Put the task in this epic of the project
      --parent <id>   Make the task a subtask of this task (not with --epic)

scan options:
      --project <id>  Project the tasks go to (default: the project of <repo>, registered if needed)
      --dry-run       List the units that would become tasks; create nothing
      --bump <s>      Status to record on success: review | done (default done)
      --tool <id>     Force all roles to this tool for the created tasks
      --model <name>  Model for --tool

Exit codes: 0 success; 1 a task failed / was stopped / parked / nothing actionable / bad usage; operation commands: 2 not found, 3 not allowed (identity, scope, project, trust), 130 interrupted.`;

/** Locate the built UI directory shipped alongside this CLI, if present. */
function resolveUiDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // From bin/dist or bin/src → ../../packages/facedisk/ui/dist
  return resolve(here, "..", "..", "packages", "facedisk", "ui", "dist");
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

/** serve's own flags: the only tokens that may stand first without the `serve` word. */
export const SERVE_FLAGS = [
  "--data",
  "-d",
  "--port",
  "-p",
  "--no-runner",
  "--host",
  "--tls-cert",
  "--tls-key",
] as const;

/** Flags that take a value, among the global ones that may stand before the command words. */
const GLOBAL_VALUE_FLAGS = new Set([
  "-d",
  "--data",
  "--client",
  "--out",
  "--input",
  "-p",
  "--port",
  "--host",
  "--tls-cert",
  "--tls-key",
]);
const GLOBAL_BOOLEAN_FLAGS = new Set(["--json", "--no-runner", "--help", "-h", "--version", "-v"]);

/**
 * Global flags may come before the command words (`boof-runner -d ./data tasks list`,
 * `boof-runner --client reader tasks list`). Move the leading flags behind the first word that is
 * not a flag, so the command is routed exactly as without them. With no such word (`-d x`, `-p 4000`)
 * the arguments stay as they are: the legacy flags-only form of `serve`.
 */
export function routeArgv(argv: string[]): string[] {
  const lead: string[] = [];
  let at = 0;
  while (at < argv.length) {
    const token = argv[at]!;
    if (!token.startsWith("-")) break;
    const flag = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    if (GLOBAL_VALUE_FLAGS.has(flag)) {
      const inline = token.includes("=");
      if (!inline && at + 1 >= argv.length) return argv;
      lead.push(...argv.slice(at, at + (inline ? 1 : 2)));
      at += inline ? 1 : 2;
    } else if (GLOBAL_BOOLEAN_FLAGS.has(flag)) {
      lead.push(token);
      at += 1;
    } else {
      return argv; // not one of ours: leave it to the command
    }
  }
  if (at === 0 || at >= argv.length) return argv;
  return [...argv.slice(at), ...lead];
}

export function isServeFlag(token: string): boolean {
  return (
    SERVE_FLAGS.includes(token as (typeof SERVE_FLAGS)[number]) ||
    SERVE_FLAGS.some((f) => f.startsWith("--") && token.startsWith(`${f}=`))
  );
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

export function handleStartupSignal(
  signal: string,
  pendingSignal: string | undefined,
  exit: (code: number) => never = process.exit,
): string {
  if (pendingSignal) {
    console.log(`\n${signal} again: exiting now`);
    exit(1);
  }
  return signal;
}

/** The original behavior: scaffold data, boot the web UI + background runner. */
export async function serve(argv: string[]): Promise<void> {
  const args = parseServeArgs(argv);
  const root = args.dataRoot;
  let starting = true;
  let pendingSignal: string | undefined;
  let shuttingDown = false;
  let stop: (() => Promise<void>) | undefined;
  const shutdown = async (signal: string) => {
    if (starting) {
      pendingSignal = handleStartupSignal(signal, pendingSignal);
      return;
    }
    if (shuttingDown) {
      console.log(`\n${signal} again: exiting now`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`\nShutting down (${signal})…`);
    await stop?.();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  const { created } = await scaffoldDataRoot(root);
  console.log(`${created ? "Scaffolded" : "Using"} data root: ${root}`);

  const uiDir = resolveUiDir();
  const guard = new RunnerGuard(root);
  try {
    const composition = await boot({
      root,
      port: args.port,
      host: args.host,
      uiDir,
      version: readVersion(),
      tlsCert: args.tlsCert ? absPath(args.tlsCert) : undefined,
      tlsKey: args.tlsKey ? absPath(args.tlsKey) : undefined,
      runner: !args.noRunner,
      guard,
      onServer: (server) => {
        if (!server) return;
        const scheme = args.tlsCert ? "https" : "http";
        const shown = args.host === "0.0.0.0" || args.host === "::" ? "localhost" : args.host;
        const hostPart = shown.includes(":") && !shown.startsWith("[") ? `[${shown}]` : shown;
        console.log(`Web UI:  ${scheme}://${hostPart}:${server.port}`);
        console.log(`API:     ${scheme}://${hostPart}:${server.port}/api`);
      },
      onRunner: (engine) => {
        if (engine) console.log("Runner:  started (toggle on/off in the UI)");
        else if (!args.noRunner)
          console.log("Runner:  already running in another process — not starting a second one");
      },
    });
    stop = async () => {
      const graceMs = Number(process.env.BOOF_RUNNER_SHUTDOWN_GRACE_MS ?? 30_000);
      await composition.stop(graceMs);
    };
  } catch (err) {
    console.error(isRunnerStartFailure(err) ? err : err instanceof Error ? err.message : err);
    process.exit(1);
  }
  starting = false;
  if (pendingSignal) void shutdown(pendingSignal);
}

/**
 * Signal for a long `run`. Tests pass their own abort signal and the run stops between ticks.
 * A real SIGINT writes the interrupted line and then dies by that signal, as it did before the
 * handler existed: the shell sees 130 and a `for` loop stops. The agent is in its own process
 * group, so this does not signal it; parent death leaves that group the way a default SIGINT did.
 */
function trackInterrupts(
  write: () => void,
  signal?: AbortSignal,
): { signal: AbortSignal; stop: () => void } {
  if (signal) return { signal, stop: () => {} };
  const controller = new AbortController();
  const onSigint = () => {
    process.removeListener("SIGINT", onSigint);
    try {
      write();
    } catch (err) {
      console.error("audit write failed", err);
    }
    process.kill(process.pid, "SIGINT");
  };
  process.once("SIGINT", onSigint);
  return { signal: controller.signal, stop: () => process.removeListener("SIGINT", onSigint) };
}

/** `run` subcommand. Returns a process exit code. `signal` stands in for SIGINT in tests. */
export async function runCommand(argv: string[], signal?: AbortSignal): Promise<number> {
  const dataOpt = getOpt(argv, ["--data", "-d"]);
  const root = dataOpt ? absPath(dataOpt) : defaultDataRoot();
  const repo = getOpt(argv, ["--repo"]);
  const tool = getOpt(argv, ["--tool"]);
  const model = getOpt(argv, ["--model"]);
  const base = getOpt(argv, ["--base"]);
  const title = getOpt(argv, ["--title"]);
  const project = getOpt(argv, ["--project"]);

  if (hasFlag(argv, ["--all"])) {
    const startedAt = Date.now();
    const noted: { projectId?: string } = {};
    const audit = beginCliAudit(root, "cli:run");
    const held = trackInterrupts(
      () => writeInterruptedSync(root, "cli:run", startedAt, noted.projectId),
      signal,
    );
    try {
      const { failed } = await drainQueue({
        root,
        ...(project ? { project } : {}),
        signal: held.signal,
        onProject: (id) => {
          noted.projectId = id;
        },
      });
      if (held.signal.aborted) {
        await audit.failCode("interrupted", noted.projectId);
        return 130;
      }
      if (failed > 0) await audit.failCode("not_done", noted.projectId);
      else await audit.ok(noted.projectId);
      return failed > 0 ? 1 : 0;
    } catch (e) {
      if (held.signal.aborted) {
        await audit.failCode("interrupted", noted.projectId);
        return 130;
      }
      await audit.fail(e, noted.projectId);
      throw e;
    } finally {
      held.stop();
    }
  }

  const file = getOpt(argv, ["--file", "-f"]);
  const prompt = file ? await readFileAsync(absPath(file), "utf8") : firstPositional(argv);
  if (!prompt || !prompt.trim()) {
    console.error("run: a prompt is required (pass text, --file <path>, or --all).\n");
    console.error(HELP);
    return 1;
  }

  const runsOpt = getOpt(argv, ["--runs"]);
  const epic = getOpt(argv, ["--epic"]);
  const parent = getOpt(argv, ["--parent"]);
  if (epic && parent) {
    console.error("run: give --epic or --parent, not both: a subtask takes its parent's epic.");
    return 1;
  }
  const startedAt = Date.now();
  const noted: { projectId?: string } = {};
  const audit = beginCliAudit(root, "cli:run");
  const held = trackInterrupts(
    () => writeInterruptedSync(root, "cli:run", startedAt, noted.projectId),
    signal,
  );
  try {
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
      ...(epic ? { epicId: epic } : {}),
      ...(parent ? { parentId: parent } : {}),
      signal: held.signal,
      onProject: (id) => {
        noted.projectId = id;
      },
    });
    if (held.signal.aborted) {
      await audit.failCode("interrupted", summary.projectId);
      return 130;
    }
    if (summary.ok) await audit.ok(summary.projectId);
    else await audit.failCode("not_done", summary.projectId);
    return summary.ok ? 0 : 1;
  } catch (e) {
    if (held.signal.aborted) {
      await audit.failCode("interrupted", noted.projectId);
      return 130;
    }
    await audit.fail(e, noted.projectId);
    throw e;
  } finally {
    held.stop();
  }
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
  const root = dataOpt ? absPath(dataOpt) : defaultDataRoot();
  const dryRun = hasFlag(argv, ["--dry-run"]);
  // A dry run and a scan that finds nothing do not write, so they leave no line.
  const noted: { projectId?: string } = {};
  const audit = dryRun ? undefined : beginCliAudit(root, "cli:scan");
  try {
    const summary = await scanRepoToTasks({
      root,
      repo,
      ...(project ? { project } : {}),
      dryRun,
      bumpTo: bump === "review" ? "review" : bump === "done" ? "done" : undefined,
      ...(tool ? { tool } : {}),
      ...(model ? { model } : {}),
      onProject: (id) => {
        noted.projectId = id;
      },
    });
    if (summary.projectId) await audit?.ok(summary.projectId);
    return 0;
  } catch (e) {
    await audit?.fail(e, noted.projectId);
    throw e;
  }
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
    "--epic",
    "--parent",
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

export async function main(rawArgv = process.argv.slice(2)): Promise<void> {
  const argv = routeArgv(rawArgv);
  const [cmd, ...rest] = argv;
  // --version also works after serve's own flags (`boof-runner -d x --version`).
  if ((cmd === "serve" || isServeFlag(cmd ?? "")) && hasFlag(argv, ["--version", "-v"])) {
    console.log(readVersion());
    return;
  }
  // Top-level --help (but let the subcommands handle their own --help). An unknown first word is
  // reported as unknown, even with --help.
  const topLevel =
    cmd === undefined ||
    cmd === "serve" ||
    cmd === "--help" ||
    cmd === "-h" ||
    cmd === "--version" ||
    cmd === "-v" ||
    isServeFlag(cmd);
  if (hasFlag(argv, ["--help", "-h"]) && topLevel) {
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

/** The words in serve's arguments that are not a flag or a flag's value: serve takes none. */
function strayWords(args: string[]): string[] {
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    const flag = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (a.startsWith("-")) {
      if (GLOBAL_VALUE_FLAGS.has(flag) && !a.includes("=")) i += 1;
      continue;
    }
    words.push(a);
  }
  return words;
}

/** `boof-runner serve tasks list` must not start a server and ignore the words. */
function refuseServe(args: string[]): number {
  console.error(
    `boof-runner: unknown command: ${strayWords(args).join(" ")} (see "boof-runner --help")`,
  );
  return 1;
}

/** Sentinel: the command (serve) keeps the process alive; main must not set an exit code. */
const SERVE_FOREVER = -1;

async function dispatch(cmd: string | undefined, rest: string[], argv: string[]): Promise<number> {
  // Generated commands: every operation of the registry as `<area> <verb>`. The hand-written
  // commands keep their words (`auth add|list|revoke|rotate`, `project`, `task`, ...).
  if (
    cmd !== undefined &&
    (cmd === "ops" ||
      matchOpCommand([cmd, ...rest]) !== undefined ||
      (isOpArea(cmd) && !(cmd in HAND_WRITTEN_COMMANDS)))
  ) {
    return opsCommand([cmd, ...rest], defaultDataRoot, {
      services: (root) => new TaskService(root, new ToolRegistry()),
    });
  }
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
    case "epic":
      code = await epicCommand(rest, defaultDataRoot);
      break;
    case "task":
      code = await taskCommand(rest, defaultDataRoot);
      break;
    case "mcp":
      code = await mcpCommand(rest, defaultDataRoot, new ToolRegistry());
      break;
    case "--version":
    case "-v":
      console.log(readVersion());
      break;
    case "serve":
      if (strayWords(rest).length > 0) return refuseServe(rest);
      await serve(rest);
      return SERVE_FOREVER; // serve runs forever
    case undefined:
      await serve([]);
      return SERVE_FOREVER;
    default:
      // Only serve's own flags may stand first (the legacy `boof-runner -d ... -p ...`
      // form); any other token is an unknown command, never a silent server start.
      if (isServeFlag(cmd)) {
        if (strayWords(argv).length > 0) return refuseServe(argv);
        await serve(argv);
        return SERVE_FOREVER;
      }
      console.error(`boof-runner: unknown command "${cmd}" (see "boof-runner --help")`);
      return 1;
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
