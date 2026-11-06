import {
  DESKTOP_CLAUDE_AGENT_REASON,
  ClaudeConcierge,
  RunnerEngine,
  ToolRegistry,
  defaultTools,
} from "@boof/runner";
import { startServer, type RunningServer, type StartServerOptions } from "@boof/heart-server";
import { RunnerGuard } from "./runner-guard.js";

export interface BootOptions extends Omit<StartServerOptions, "catalog" | "runnerRunning"> {
  runner?: boolean;
  claudeAgent?: "enabled" | "unavailable";
  guard?: RunnerGuard;
  /** Root-specific server settings such as desktop operator clients. */
  serverOptions?: Partial<StartServerOptions>;
  onServer?: (server: RunningServer | null) => void | Promise<void>;
  onRunner?: (engine: RunnerEngine | null) => void;
}

export interface Booted {
  server: RunningServer;
  engine: RunnerEngine | null;
  stop(graceMs: number): Promise<{ stopped: string[]; timedOut: boolean }>;
}

const runnerStartFailures = new WeakSet<object>();

export function isRunnerStartFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && runnerStartFailures.has(error);
}

/** Compose the shared server and runner lifecycle used by the CLI and Electron. */
export async function boot(opts: BootOptions): Promise<Booted> {
  const { runner, guard, serverOptions, onServer, onRunner, claudeAgent, ...commonServerOptions } =
    opts;
  const registry = new ToolRegistry(
    defaultTools(
      claudeAgent === "unavailable" ? { claudeAgentUnavailable: DESKTOP_CLAUDE_AGENT_REASON } : {},
    ),
  );
  const conciergeAgent = new ClaudeConcierge({
    root: opts.root,
    unavailableReason: claudeAgent === "unavailable" ? DESKTOP_CLAUDE_AGENT_REASON : undefined,
  });
  let engine: RunnerEngine | null = null;
  const server = await startServer({
    ...commonServerOptions,
    ...serverOptions,
    root: opts.root,
    catalog: registry,
    conciergeAgent,
    runnerRunning: () => engine !== null,
  });
  await onServer?.(server);
  try {
    if (runner !== false && (!guard || (await guard.acquire()))) {
      engine = new RunnerEngine({ root: opts.root, registry });
      onRunner?.(engine);
      void engine.loop();
    } else {
      onRunner?.(null);
    }
  } catch (error) {
    await server.stop();
    await onServer?.(null);
    if (typeof error === "object" && error !== null) runnerStartFailures.add(error);
    throw error;
  }
  return {
    server,
    engine,
    stop: async (graceMs) => {
      let result = { stopped: [] as string[], timedOut: false };
      try {
        if (engine) result = await engine.shutdown(graceMs);
        if (result.stopped.length)
          console.log(`Stopped running task(s): ${result.stopped.join(", ")}`);
        if (result.timedOut) console.log(`Grace period of ${graceMs} ms elapsed; exiting anyway`);
      } finally {
        await guard?.release();
        await server.stop();
      }
      return result;
    },
  };
}
