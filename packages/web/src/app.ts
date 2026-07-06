import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { ServiceError, TaskService } from "./service.js";
import { DataWatcher } from "./watch.js";

export interface AppDeps {
  service: TaskService;
  watcher?: DataWatcher;
  /** Absolute path to the built UI directory (index.html + assets), if any. */
  uiDir?: string;
}

/**
 * Build the Hono app: a file-backed REST API plus an SSE stream and (optionally)
 * the static UI. Bound to localhost by the server bootstrap; no auth (single
 * local user).
 */
export function createApp(deps: AppDeps): Hono {
  const { service } = deps;
  const app = new Hono();

  const wrap = (fn: (c: Context) => Promise<unknown>) => async (c: Context) => {
    try {
      const result = await fn(c);
      return c.json(result as object);
    } catch (err) {
      if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 400);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  };

  const api = new Hono();

  // --- Tasks ---
  api.get(
    "/tasks",
    wrap(async () => ({ tasks: await service.list() })),
  );
  api.get(
    "/tasks/:id",
    wrap(async (c) => {
      const task = await service.get(c.req.param("id")!);
      if (!task) throw new ServiceError(404, "Task not found");
      return task;
    }),
  );
  api.post(
    "/tasks",
    wrap(async (c) => service.create(await c.req.json())),
  );
  api.put(
    "/tasks/:id",
    wrap(async (c) => service.update(c.req.param("id")!, await c.req.json())),
  );
  api.post(
    "/tasks/:id/skip",
    wrap(async (c) => service.setSkip(c.req.param("id")!, Boolean((await c.req.json()).skip))),
  );
  api.post(
    "/tasks/reorder",
    wrap(async (c) => ({ tasks: await service.reorder((await c.req.json()).order ?? []) })),
  );
  api.post(
    "/tasks/:id/retry",
    wrap(async (c) => service.retry(c.req.param("id")!)),
  );
  api.get(
    "/tasks/:id/live-log",
    wrap(async (c) => service.liveLog(c.req.param("id")!)),
  );
  api.post(
    "/tasks/:id/stop",
    wrap(async (c) => service.stopTask(c.req.param("id")!)),
  );
  api.post(
    "/tasks/:id/inject",
    wrap(async (c) => service.injectPrompt(c.req.param("id")!, (await c.req.json()).prompt ?? "")),
  );
  api.post(
    "/tasks/:id/archive",
    wrap(async (c) => service.archive(c.req.param("id")!)),
  );
  api.post(
    "/tasks/:id/unarchive",
    wrap(async (c) => service.unarchive(c.req.param("id")!)),
  );
  api.delete(
    "/tasks/:id",
    wrap(async (c) => service.deleteTask(c.req.param("id")!)),
  );
  api.post(
    "/tasks/:id/answers",
    wrap(async (c) =>
      service.submitAnswers(c.req.param("id")!, (await c.req.json()).answers ?? ""),
    ),
  );

  // --- Attachments (images / PDFs on a task's prompt) ---
  api.post(
    "/tasks/:id/attachments",
    wrap(async (c) => {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!(file instanceof File)) throw new ServiceError(400, "No file provided");
      const bytes = new Uint8Array(await file.arrayBuffer());
      return service.addAttachment(c.req.param("id")!, file.name, file.type, bytes);
    }),
  );
  api.delete(
    "/tasks/:id/attachments/:name",
    wrap(async (c) =>
      service.removeAttachment(c.req.param("id")!, decodeURIComponent(c.req.param("name")!)),
    ),
  );
  api.get("/tasks/:id/attachments/:name", async (c) => {
    try {
      const { bytes, type } = await service.getAttachment(
        c.req.param("id")!,
        decodeURIComponent(c.req.param("name")!),
      );
      // Return a native Response: a Uint8Array is a valid BodyInit, sidestepping
      // Hono's c.body() typing which doesn't accept Node Buffers directly.
      return new Response(new Uint8Array(bytes), {
        headers: { "Content-Type": type, "Cache-Control": "no-cache" },
      });
    } catch (err) {
      if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 400);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // --- Commands ---
  api.get(
    "/commands",
    wrap(async () => ({ commands: await service.listCommands() })),
  );
  api.post(
    "/commands",
    wrap(async (c) => {
      const { name, body } = await c.req.json();
      return service.upsertCommand(name, body ?? "");
    }),
  );
  api.put(
    "/commands/:id",
    wrap(async (c) => {
      const { name, body } = await c.req.json();
      return service.renameCommand(c.req.param("id")!, name, body ?? "");
    }),
  );
  api.delete(
    "/commands/:id",
    wrap(async (c) => service.deleteCommand(c.req.param("id")!)),
  );

  // --- Settings / health / usage ---
  api.get(
    "/settings",
    wrap(async () => service.loadSettings()),
  );
  api.put(
    "/settings",
    wrap(async (c) => service.updateSettings(await c.req.json())),
  );
  api.get(
    "/health",
    wrap(async () => ({ tools: await service.health() })),
  );
  api.get(
    "/models",
    wrap(async () => ({ models: await service.listModels() })),
  );
  api.get(
    "/usage",
    wrap(async () => service.loadUsage()),
  );

  // --- SSE live updates ---
  api.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "ready", data: "connected" });
      if (!deps.watcher) {
        // No watcher (e.g. tests): keep the stream open briefly then end.
        return;
      }
      const unsub = deps.watcher.subscribe((event) => {
        void stream.writeSSE({ event, data: String(Date.now()) });
      });
      // Keep the connection open until the client disconnects.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          unsub();
          resolve();
        });
      });
    }),
  );

  app.route("/api", api);

  // --- Static UI (optional) ---
  if (deps.uiDir && existsSync(deps.uiDir)) {
    app.use("/*", serveStatic({ root: deps.uiDir }));
    app.get("/*", serveStatic({ path: "index.html", root: deps.uiDir }));
  } else {
    app.get("/", (c) => c.text("Boof Runner Agent Task Runner — UI not built. API at /api/*"));
  }

  return app;
}
