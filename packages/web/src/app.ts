import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import {
  InvalidIdError,
  InvalidTransitionError,
  MAX_ATTACHMENT_BYTES,
  SettingsPatchSchema,
  TaskNotFoundError,
} from "@boof-runner/shared";
import { hostGuard } from "./middleware/host-guard.js";
import {
  AnswersBody,
  CommandBody,
  CreateTaskBody,
  InjectBody,
  ReorderBody,
  SkipBody,
  UpdateTaskBody,
  formatIssues,
  paramId,
  parseJson,
} from "./validation.js";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { ServiceError, TaskService } from "./service.js";
import { DataWatcher } from "./watch.js";

export interface AppDeps {
  service: TaskService;
  watcher?: DataWatcher;
  /** Absolute path to the built UI directory (index.html + assets), if any. */
  uiDir?: string;
  /** Extra Host header names accepted besides loopback (DNS-rebinding guard). */
  allowedHosts?: string[];
}

const JSON_BODY_LIMIT = 1_000_000;
const ATTACHMENT_BODY_LIMIT = MAX_ATTACHMENT_BYTES + 64 * 1024;

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** Map any thrown value to a status + the public error envelope. Never leaks internals. */
function toErrorResponse(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof ServiceError) {
    const e: ErrorBody["error"] = { code: err.code, message: err.message };
    if (err.details !== undefined) e.details = err.details;
    return { status: err.status, body: { error: e } };
  }
  if (err instanceof TaskNotFoundError) {
    return { status: 404, body: { error: { code: "not_found", message: err.message } } };
  }
  if (err instanceof InvalidTransitionError) {
    return {
      status: 409,
      body: { error: { code: "invalid_transition", message: err.message } },
    };
  }
  if (err instanceof InvalidIdError) {
    return { status: 400, body: { error: { code: "invalid_input", message: err.message } } };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: { code: "invalid_input", message: "Invalid input", details: formatIssues(err) },
      },
    };
  }
  console.error(err);
  return { status: 500, body: { error: { code: "internal", message: "Internal error" } } };
}

/**
 * Build the Hono app: a file-backed REST API plus an SSE stream and (optionally)
 * the static UI. Bound to localhost by the server bootstrap; no auth (single
 * local user).
 */
export function createApp(deps: AppDeps): Hono {
  const { service } = deps;
  const app = new Hono();

  app.use(
    "*",
    hostGuard(() => deps.allowedHosts ?? []),
  );
  app.use("*", secureHeaders());

  const tooLarge = (c: Context) =>
    c.json({ error: { code: "payload_too_large", message: "Request body too large" } }, 413);
  const jsonLimit = bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: tooLarge });
  const attachmentLimit = bodyLimit({ maxSize: ATTACHMENT_BODY_LIMIT, onError: tooLarge });
  app.use("/api/*", (c, next) =>
    c.req.method === "POST" && /^\/api\/tasks\/[^/]+\/attachments\/?$/.test(c.req.path)
      ? attachmentLimit(c, next)
      : jsonLimit(c, next),
  );

  app.onError((err, c) => {
    const { status, body } = toErrorResponse(err);
    return c.json(body, status as 400);
  });

  const wrap = (fn: (c: Context) => Promise<unknown>) => async (c: Context) => {
    try {
      const result = await fn(c);
      return c.json(result as object);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as 400);
    }
  };

  const id = (c: Context) => paramId(c.req.param("id"));

  const api = new Hono();

  // --- Tasks ---
  api.get(
    "/tasks",
    wrap(async () => ({ tasks: await service.list() })),
  );
  api.get(
    "/tasks/:id",
    wrap(async (c) => {
      const task = await service.get(id(c));
      if (!task) throw new ServiceError(404, "Task not found");
      return task;
    }),
  );
  api.post(
    "/tasks",
    wrap(async (c) => service.create(await parseJson(c.req, CreateTaskBody))),
  );
  api.put(
    "/tasks/:id",
    wrap(async (c) => service.update(id(c), await parseJson(c.req, UpdateTaskBody))),
  );
  api.post(
    "/tasks/:id/skip",
    wrap(async (c) => service.setSkip(id(c), (await parseJson(c.req, SkipBody)).skip)),
  );
  api.post(
    "/tasks/reorder",
    wrap(async (c) => ({
      tasks: await service.reorder((await parseJson(c.req, ReorderBody)).order),
    })),
  );
  api.post(
    "/tasks/:id/retry",
    wrap(async (c) => service.retry(id(c))),
  );
  api.get(
    "/tasks/:id/live-log",
    wrap(async (c) => service.liveLog(id(c))),
  );
  api.post(
    "/tasks/:id/stop",
    wrap(async (c) => service.stopTask(id(c))),
  );
  api.post(
    "/tasks/:id/inject",
    wrap(async (c) => service.injectPrompt(id(c), (await parseJson(c.req, InjectBody)).prompt)),
  );
  api.post(
    "/tasks/:id/archive",
    wrap(async (c) => service.archive(id(c))),
  );
  api.post(
    "/tasks/:id/unarchive",
    wrap(async (c) => service.unarchive(id(c))),
  );
  api.delete(
    "/tasks/:id",
    wrap(async (c) => service.deleteTask(id(c))),
  );
  api.post(
    "/tasks/:id/answers",
    wrap(async (c) => service.submitAnswers(id(c), (await parseJson(c.req, AnswersBody)).answers)),
  );

  // --- Attachments (images / PDFs on a task's prompt) ---
  api.post(
    "/tasks/:id/attachments",
    wrap(async (c) => {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!(file instanceof File)) throw new ServiceError(400, "No file provided");
      const bytes = new Uint8Array(await file.arrayBuffer());
      return service.addAttachment(id(c), file.name, file.type, bytes);
    }),
  );
  api.delete(
    "/tasks/:id/attachments/:name",
    wrap(async (c) => service.removeAttachment(id(c), decodeURIComponent(c.req.param("name")!))),
  );
  api.get("/tasks/:id/attachments/:name", async (c) => {
    try {
      const { bytes, type } = await service.getAttachment(
        id(c),
        decodeURIComponent(c.req.param("name")!),
      );
      // Return a native Response: a Uint8Array is a valid BodyInit, sidestepping
      // Hono's c.body() typing which doesn't accept Node Buffers directly.
      return new Response(new Uint8Array(bytes), {
        headers: { "Content-Type": type, "Cache-Control": "no-cache" },
      });
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as 400);
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
      const { name, body } = await parseJson(c.req, CommandBody);
      return service.upsertCommand(name, body ?? "");
    }),
  );
  api.put(
    "/commands/:id",
    wrap(async (c) => {
      const { name, body } = await parseJson(c.req, CommandBody);
      return service.renameCommand(id(c), name, body ?? "");
    }),
  );
  api.delete(
    "/commands/:id",
    wrap(async (c) => service.deleteCommand(id(c))),
  );

  // --- Settings / health / usage ---
  api.get(
    "/settings",
    wrap(async () => service.loadSettings()),
  );
  api.put(
    "/settings",
    wrap(async (c) => service.updateSettings(await parseJson(c.req, SettingsPatchSchema))),
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
