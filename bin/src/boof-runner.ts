import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerEngine } from "@boof-runner/runner";
import { startServer } from "@boof-runner/web";
import { scaffoldDataRoot } from "./scaffold.js";
import { RunnerGuard } from "./runner-guard.js";

interface CliArgs {
  dataRoot: string;
  port: number;
  noRunner: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dataRoot: process.env.BOOF_RUNNER_DATA_ROOT ?? resolve(process.cwd(), "data"),
    port: Number(process.env.BOOF_RUNNER_PORT ?? 4319),
    noRunner: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--data" || a === "-d") {
      const v = argv[++i];
      args.dataRoot = isAbsolute(v) ? v : resolve(process.cwd(), v);
    } else if (a === "--port" || a === "-p") {
      args.port = Number(argv[++i]);
    } else if (a === "--no-runner") {
      args.noRunner = true;
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    }
  }
  return args;
}

const HELP = `boof-runner — Agent Task Runner

Usage: boof-runner [options]

Options:
  -d, --data <path>   Data root directory (default: ./data, or $BOOF_RUNNER_DATA_ROOT)
  -p, --port <n>      Web server port (default: 4319, or $BOOF_RUNNER_PORT)
      --no-runner     Start the web server only (do not start the runner)
  -h, --help          Show this help

First run scaffolds the data root and settings.json. The runner starts when the
app launches; it does not register an OS boot service.`;

/** Locate the built UI directory shipped alongside this CLI, if present. */
function resolveUiDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // From bin/dist or bin/src → ../../packages/web/ui/dist
  return resolve(here, "..", "..", "packages", "web", "ui", "dist");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return;
  }

  const root = args.dataRoot;
  const { created } = await scaffoldDataRoot(root);
  console.log(`${created ? "Scaffolded" : "Using"} data root: ${root}`);

  const uiDir = resolveUiDir();
  const running = await startServer({ root, port: args.port, uiDir });
  console.log(`Web UI:  http://127.0.0.1:${running.port}`);
  console.log(`API:     http://127.0.0.1:${running.port}/api`);

  let engine: RunnerEngine | null = null;
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

  const shutdown = async () => {
    console.log("\nShutting down…");
    engine?.stop();
    await guard.release();
    await running.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Run when invoked directly (not when imported by tests). Resolve symlinks so a
// globally-installed `boof-runner` shim (e.g. /usr/local/bin/boof-runner → …/bin/dist/boof-runner.js)
// still matches this module's real path.
const entryPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
const selfPath = fileURLToPath(import.meta.url);
const invokedDirectly = entryPath === selfPath || entryPath.endsWith(join("bin", "src", "boof-runner.ts"));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
