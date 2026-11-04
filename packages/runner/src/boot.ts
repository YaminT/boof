/** Shared server/runner startup and shutdown ordering for CLI and desktop roots. */
export interface BootDependencies<Server, Runner> {
  startServer: () => Promise<Server>;
  afterServer?: (server: Server) => void | Promise<void>;
  startRunner?: (server: Server) => Runner | null | Promise<Runner | null>;
  stopRunner?: (runner: Runner | null) => void | Promise<void>;
  afterRunnerStop?: () => void | Promise<void>;
  stopServer: (server: Server) => void | Promise<void>;
}

export interface BootResult<Server, Runner> {
  server: Server;
  runner: Runner | null;
  stop: () => Promise<void>;
}

/** Start the server before the runner; stop the runner before releasing server resources. */
export async function boot<Server, Runner>(
  deps: BootDependencies<Server, Runner>,
): Promise<BootResult<Server, Runner>> {
  const server = await deps.startServer();
  await deps.afterServer?.(server);
  const runner = (await deps.startRunner?.(server)) ?? null;
  return {
    server,
    runner,
    stop: async () => {
      await deps.stopRunner?.(runner);
      await deps.afterRunnerStop?.();
      await deps.stopServer(server);
    },
  };
}
