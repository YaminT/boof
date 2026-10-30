// Desktop lifecycle logic kept free of `electron` so it can be unit-tested without an
// Electron runtime. main.ts wires these functions to the app, the server and the engine.
import type { RunnerEngine } from "@boof-runner/runner";
import type { RunningServer, startServer } from "@boof-runner/web";

export type ServerOptions = Parameters<typeof startServer>[0];

/** Server options for the desktop app: the app version and whether the engine loop runs. */
export function serverOptions(
  base: Pick<ServerOptions, "root" | "port" | "uiDir">,
  version: string,
  engine: () => RunnerEngine | null,
): ServerOptions {
  return { ...base, version, runnerRunning: () => engine() !== null };
}

const DEFAULT_GRACE_MS = 30_000;

/** Grace period for a graceful shutdown, from BOOF_RUNNER_SHUTDOWN_GRACE_MS (default 30 s). */
export function shutdownGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const ms = Number(env.BOOF_RUNNER_SHUTDOWN_GRACE_MS ?? DEFAULT_GRACE_MS);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_GRACE_MS;
}

export interface QuitDeps {
  engine: () => Pick<RunnerEngine, "shutdown"> | null;
  server: () => Pick<RunningServer, "stop"> | null;
  exit: (code: number) => void;
  graceMs: number;
  log: (line: string) => void;
}

export interface QuitEvent {
  preventDefault(): void;
}

/**
 * Handler for Electron's `before-quit`. The first request defers the quit, drains the
 * engine (running tasks end as `stopped`), stops the server and exits 0. A second
 * request while draining is not deferred, so Electron quits at once.
 */
export function createQuitHandler(deps: QuitDeps): (event: QuitEvent) => Promise<void> | undefined {
  let draining = false;
  return (event) => {
    if (draining) return undefined;
    draining = true;
    event.preventDefault();
    return (async () => {
      try {
        const engine = deps.engine();
        if (engine) {
          const { stopped, timedOut } = await engine.shutdown(deps.graceMs);
          if (stopped.length > 0) deps.log(`Stopped running task(s): ${stopped.join(", ")}`);
          if (timedOut) deps.log(`Grace period of ${deps.graceMs} ms elapsed; quitting anyway`);
        }
        await deps.server()?.stop();
      } catch (err) {
        deps.log(`Shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        deps.exit(0);
      }
    })();
  };
}
