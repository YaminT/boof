import { serve, type ServerType } from "@hono/node-server";
import { ToolRegistry } from "@boof-runner/runner";
import { createApp } from "./app.js";
import { TaskService } from "./service.js";
import { DataWatcher } from "./watch.js";

export interface StartServerOptions {
  root: string;
  port?: number;
  host?: string;
  uiDir?: string;
  /** Extra Host header names accepted besides loopback. */
  allowedHosts?: string[];
  registry?: ToolRegistry;
}

export interface RunningServer {
  server: ServerType;
  watcher: DataWatcher;
  service: TaskService;
  port: number;
  stop: () => Promise<void>;
}

/**
 * Start the web server on localhost. Uses @hono/node-server, which runs on both
 * Node and Bun (node:http compatible), satisfying the dual-runtime requirement.
 */
export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const service = new TaskService(opts.root, opts.registry ?? new ToolRegistry());
  await service.tasks.ensureDirs();
  await service.loadSettings(); // scaffolds settings.json if missing

  const watcher = new DataWatcher(opts.root);
  watcher.start();

  const app = createApp({ service, watcher, uiDir: opts.uiDir, allowedHosts: opts.allowedHosts });
  const host = opts.host ?? "127.0.0.1";

  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: host, port: opts.port ?? 4319 }, () =>
      resolve(s),
    );
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 4319);

  return {
    server,
    watcher,
    service,
    port,
    stop: async () => {
      await watcher.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
