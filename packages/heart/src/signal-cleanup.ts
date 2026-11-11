import { rmSync } from "node:fs";

export interface SignalCleanup {
  /** Add a path that is removed when SIGINT or SIGTERM arrives. */
  add(path: string): void;
  /** True once a signal arrived. The publish step must not run then. */
  interrupted(): boolean;
  /** Remove the handlers. */
  dispose(): void;
}

export interface SignalCleanupOptions {
  /** Re-raise the signal. Injected by tests. */
  kill?: (signal: NodeJS.Signals) => void;
  /** Where to listen. Injected by tests. */
  target?: Pick<NodeJS.Process, "once" | "removeListener">;
}

/**
 * Remove the given paths when SIGINT or SIGTERM arrives, then re-raise the signal.
 * The removal is synchronous, so the main flow cannot run (and publish a half-removed tree)
 * between the removal and the exit.
 */
export function installSignalCleanup(
  paths: string[],
  opts: SignalCleanupOptions = {},
): SignalCleanup {
  const target = opts.target ?? process;
  const kill =
    opts.kill ??
    ((signal: NodeJS.Signals): void => {
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exitCode = signal === "SIGINT" ? 130 : 143;
      }
    });
  const handlers = new Map<NodeJS.Signals, () => void>();
  let stopped = false;
  const dispose = (): void => {
    for (const [signal, handler] of handlers) target.removeListener(signal, handler);
    handlers.clear();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      stopped = true;
      for (const path of paths) {
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          /* Best effort: the signal still ends the process. */
        }
      }
      dispose();
      kill(signal);
    };
    handlers.set(signal, handler);
    target.once(signal, handler);
  }
  return { add: (path) => void paths.push(path), interrupted: () => stopped, dispose };
}
