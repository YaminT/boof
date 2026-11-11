import {
  DESKTOP_CLAUDE_AGENT_REASON,
  ClaudeConcierge,
  RunnerEngine,
  ToolRegistry,
  defaultTools,
} from "@boof/runner";
import {
  BOOF_VERSION,
  checkForUpdate,
  type ConciergeAgent,
  type Settings,
  type UpdateFetch,
} from "@boof/heart";
import {
  createN8nTransport,
  createSelfUrlCheck,
  startServer,
  type RunningServer,
  type StartServerOptions,
} from "@boof/heart-server";
import { RunnerGuard } from "./runner-guard.js";

export interface BootOptions extends Omit<StartServerOptions, "catalog" | "runnerRunning"> {
  runner?: boolean;
  claudeAgent?: "enabled" | "unavailable";
  /** Replaces the assistant implementation. Only the dev flag in `boof-runner.ts` sets it. */
  conciergeAgent?: ConciergeAgent;
  guard?: RunnerGuard;
  /** Root-specific server settings such as desktop operator clients. */
  serverOptions?: Partial<StartServerOptions>;
  /**
   * When set, ask GitHub once after the server is listening. Omit it in tests: the default
   * fetch is the real network. A failure never stops startup, and the check does not delay listen.
   */
  updates?: { fetchImpl?: UpdateFetch; now?: () => Date; env?: NodeJS.ProcessEnv };
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

const DEFAULT_SERVER_PORT = 4319;

/**
 * The self check for a process without the server: the one in heart-server, with
 * `$BOOF_RUNNER_PORT` (default 4319), the configured `allowedHosts` and the port of
 * `n8n.callbackBaseUrl` when its host is local.
 */
export function headlessSelfCheck(settings: Settings): (u: URL) => boolean {
  return createSelfUrlCheck({
    port: Number(process.env.BOOF_RUNNER_PORT ?? DEFAULT_SERVER_PORT),
    allowedHosts: settings.security?.allowedHosts,
    callbackBaseUrl: settings.n8n?.callbackBaseUrl,
  });
}

/** Compose the shared server and runner lifecycle used by the CLI and Electron. */
export async function boot(opts: BootOptions): Promise<Booted> {
  const {
    runner,
    guard,
    serverOptions,
    onServer,
    onRunner,
    claudeAgent,
    conciergeAgent: conciergeOverride,
    updates,
    ...commonServerOptions
  } = opts;
  const registry = new ToolRegistry(
    defaultTools(
      claudeAgent === "unavailable" ? { claudeAgentUnavailable: DESKTOP_CLAUDE_AGENT_REASON } : {},
    ),
  );
  const conciergeAgent =
    conciergeOverride ??
    new ClaudeConcierge({
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
  if (updates) {
    void checkForUpdate({
      root: opts.root,
      version: opts.version ?? BOOF_VERSION,
      ...(updates.fetchImpl ? { fetchImpl: updates.fetchImpl } : {}),
      ...(updates.now ? { now: updates.now } : {}),
      env: updates.env ?? process.env,
    }).catch(() => {});
  }
  try {
    if (runner !== false && (!guard || (await guard.acquire()))) {
      engine = new RunnerEngine({
        root: opts.root,
        registry,
        external: createN8nTransport({
          root: opts.root,
          via: "runner",
          isSelfUrl: server.isSelfUrl,
        }),
      });
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
