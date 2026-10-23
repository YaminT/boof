import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import {
  AuthStore,
  hasScope,
  InvalidIdError,
  InvalidTransitionError,
  MAX_ATTACHMENT_BYTES,
  authorizeProject,
  ProjectPatchSchema,
  SettingsPatchSchema,
  TaskNotFoundError,
  toPublicClient,
  parseDuration,
} from "@boof-runner/shared";
import { hostGuard } from "./middleware/host-guard.js";
import {
  authenticate,
  defaultPeerAddress,
  requireAnyScope,
  requireScope,
  type PeerAddressResolver,
} from "./middleware/auth.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { audit, promptFingerprint } from "./middleware/audit.js";
import { securityConfigReader } from "./security-config.js";
import {
  AnswersBody,
  CommandBody,
  CreateClientBody,
  CreateProjectBody,
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
import { ServiceError, TaskService, toTaskView, type ProjectService } from "./service.js";
import { DataWatcher } from "./watch.js";

export interface AppDeps {
  service: TaskService;
  watcher?: DataWatcher;
  /** Absolute path to the built UI directory (index.html + assets), if any. */
  uiDir?: string;
  /** Extra Host header names accepted besides loopback (DNS-rebinding guard). */
  allowedHosts?: string[];
  /** Client registry; defaults to <data>/auth/clients.json under the service root. */
  authStore?: AuthStore;
  /** Resolves the TCP peer address (loopback detection). Default: the socket's remote address. */
  peerAddress?: PeerAddressResolver;
  /** Clock override for tests (rate limit, client cache, audit). */
  now?: () => number;
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
 * the static UI. Authentication and authorization live in middleware/auth.ts:
 * loopback peers are trusted under `local-trust`, everyone else needs a bearer key.
 */
export function createApp(deps: AppDeps): Hono {
  const { service } = deps;
  const app = new Hono();

  const security = securityConfigReader(service);
  const authStore = deps.authStore ?? new AuthStore(service.root, deps.now);
  const peerAddress = deps.peerAddress ?? defaultPeerAddress;

  app.use(
    "*",
    hostGuard(async () => [...(deps.allowedHosts ?? []), ...(await security()).allowedHosts]),
  );
  app.use("*", secureHeaders());
  // Outermost on /api so rejected requests (401/403/429) are audited too.
  app.use("/api/*", audit({ root: service.root, security, now: deps.now }));

  const tooLarge = (c: Context) =>
    c.json({ error: { code: "payload_too_large", message: "Request body too large" } }, 413);
  const jsonLimit = bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: tooLarge });
  const attachmentLimit = bodyLimit({ maxSize: ATTACHMENT_BODY_LIMIT, onError: tooLarge });
  app.use("/api/*", (c, next) =>
    c.req.method === "POST" &&
    /^\/api\/(projects\/[^/]+\/)?tasks\/[^/]+\/attachments\/?$/.test(c.req.path)
      ? attachmentLimit(c, next)
      : jsonLimit(c, next),
  );
  app.use("/api/*", authenticate({ store: authStore, security, peerAddress, now: deps.now }));
  app.use("/api/*", rateLimit({ security, now: deps.now }));

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
  const who = (c: Context) => c.get("principal");

  const api = new Hono();

  /** Check the principal may touch project `pid` (403 before 404, so existence is not probed). */
  const allow = (c: Context, pid: string): void => {
    if (!authorizeProject(who(c), pid)) {
      throw new ServiceError(
        403,
        `This client may not access project: ${pid}`,
        "forbidden_project",
        { project: pid },
      );
    }
  };
  const allowed = (c: Context) => (pid: string) => authorizeProject(who(c), pid);

  /** Resolve `:pid` -> an existing project the principal may access. */
  const projectFromParam = async (c: Context): Promise<ProjectService> => {
    const pid = paramId(c.req.param("pid"), "project id");
    allow(c, pid);
    return service.requireProject(pid);
  };

  /** Legacy `/api/tasks…`: the project named by `settings.defaultProject`. */
  const projectFromDefault = async (c: Context): Promise<ProjectService> => {
    c.header("Deprecation", "true");
    const pid = (await service.loadSettings()).defaultProject;
    if (!pid) {
      throw new ServiceError(
        404,
        "No default project is set; use /api/projects/:pid/tasks",
        "no_default_project",
      );
    }
    allow(c, pid);
    return service.requireProject(pid);
  };

  // --- Projects ---
  api.get(
    "/projects",
    requireScope("projects:read"),
    wrap(async (c) => ({
      projects: (
        await service.listProjects({ includeArchived: c.req.query("includeArchived") === "1" })
      ).filter((p) => authorizeProject(who(c), p.id)),
    })),
  );
  api.post(
    "/projects",
    requireScope("projects:write"),
    wrap(async (c) => service.createProject(await parseJson(c.req, CreateProjectBody), who(c))),
  );
  api.get(
    "/projects/:pid",
    requireScope("projects:read"),
    wrap(async (c) => {
      const pid = paramId(c.req.param("pid"), "project id");
      allow(c, pid);
      return service.getProject(pid);
    }),
  );
  const projectAction = (
    path: string,
    scope: "projects:write" | "runner:control",
    run: (pid: string, c: Context) => Promise<unknown>,
    method: "post" | "put" | "delete" = "post",
  ) =>
    api[method](
      `/projects/:pid${path}`,
      scope === "runner:control"
        ? requireAnyScope(["runner:control", "projects:write"])
        : requireScope(scope),
      wrap(async (c) => {
        const pid = paramId(c.req.param("pid"), "project id");
        allow(c, pid);
        return run(pid, c);
      }),
    );
  projectAction(
    "",
    "projects:write",
    async (pid, c) =>
      service.updateProject(pid, await parseJson(c.req, ProjectPatchSchema), who(c)),
    "put",
  );
  projectAction("/archive", "projects:write", (pid) => service.archiveProject(pid));
  projectAction("/unarchive", "projects:write", (pid) => service.unarchiveProject(pid));
  projectAction("/pause", "runner:control", (pid) => service.pauseProject(pid));
  projectAction("/resume", "runner:control", (pid) => service.resumeProject(pid));
  projectAction(
    "",
    "projects:write",
    (pid, c) => service.removeProject(pid, { purge: c.req.query("purge") === "1" }),
    "delete",
  );
  api.get(
    "/projects/:pid/usage",
    requireAnyScope(["projects:read", "tasks:read"]),
    wrap(async (c) => {
      const pid = paramId(c.req.param("pid"), "project id");
      allow(c, pid);
      return service.projectUsage(pid);
    }),
  );
  api.get(
    "/actions",
    requireScope("tasks:read"),
    wrap(async (c) => ({ actions: await service.listActions(allowed(c)) })),
  );

  // --- Tasks: `/projects/:pid/tasks…`, plus the deprecated `/tasks…` alias to the default project ---
  const registerTaskRoutes = (
    prefix: string,
    resolveProject: (c: Context) => Promise<ProjectService>,
  ) => {
    const p = (path: string) => `${prefix}${path}`;
    const task = (fn: (svc: ProjectService, c: Context) => Promise<unknown>) =>
      wrap(async (c) => fn(await resolveProject(c), c));
    const view = (svc: ProjectService, t: Parameters<typeof toTaskView>[1]) =>
      toTaskView(svc.projectId, t);

    api.get(
      p("/tasks"),
      requireScope("tasks:read"),
      task(async (svc) => ({ tasks: (await svc.list()).map((t) => view(svc, t)) })),
    );
    api.get(
      p("/tasks/:id"),
      requireScope("tasks:read"),
      task(async (svc, c) => {
        const t = await svc.get(id(c));
        if (!t) throw new ServiceError(404, "Task not found");
        return view(svc, t);
      }),
    );
    api.post(
      p("/tasks"),
      requireScope("tasks:write"),
      task(async (svc, c) => {
        const body = await parseJson(c.req, CreateTaskBody);
        c.set("auditExtra", promptFingerprint(body.prompt ?? ""));
        return view(svc, await svc.create(body, who(c)));
      }),
    );
    api.put(
      p("/tasks/:id"),
      requireScope("tasks:write"),
      task(async (svc, c) =>
        view(svc, await svc.update(id(c), await parseJson(c.req, UpdateTaskBody), who(c))),
      ),
    );
    api.post(
      p("/tasks/:id/skip"),
      requireScope("tasks:write"),
      task(async (svc, c) =>
        view(svc, await svc.setSkip(id(c), (await parseJson(c.req, SkipBody)).skip)),
      ),
    );
    api.post(
      p("/tasks/reorder"),
      requireScope("tasks:write"),
      task(async (svc, c) => ({
        tasks: (await svc.reorder((await parseJson(c.req, ReorderBody)).order)).map((t) =>
          view(svc, t),
        ),
      })),
    );
    api.post(
      p("/tasks/:id/retry"),
      requireScope("tasks:write"),
      task(async (svc, c) => view(svc, await svc.retry(id(c), who(c)))),
    );
    api.get(
      p("/tasks/:id/live-log"),
      requireScope("tasks:read"),
      task(async (svc, c) => svc.liveLog(id(c))),
    );
    api.post(
      p("/tasks/:id/stop"),
      requireScope("tasks:control"),
      task(async (svc, c) => svc.stopTask(id(c))),
    );
    api.post(
      p("/tasks/:id/inject"),
      requireScope("tasks:control"),
      task(async (svc, c) => svc.injectPrompt(id(c), (await parseJson(c.req, InjectBody)).prompt)),
    );
    api.post(
      p("/tasks/:id/archive"),
      requireScope("tasks:write"),
      task(async (svc, c) => view(svc, await svc.archive(id(c)))),
    );
    api.post(
      p("/tasks/:id/unarchive"),
      requireScope("tasks:write"),
      task(async (svc, c) => view(svc, await svc.unarchive(id(c), who(c)))),
    );
    api.delete(
      p("/tasks/:id"),
      requireScope("tasks:write"),
      task(async (svc, c) => svc.deleteTask(id(c))),
    );
    api.post(
      p("/tasks/:id/answers"),
      requireScope("tasks:write"),
      task(async (svc, c) =>
        view(
          svc,
          await svc.submitAnswers(id(c), (await parseJson(c.req, AnswersBody)).answers, who(c)),
        ),
      ),
    );

    // Attachments (images / PDFs on a task's prompt)
    api.post(
      p("/tasks/:id/attachments"),
      requireScope("tasks:write"),
      task(async (svc, c) => {
        const body = await c.req.parseBody();
        const file = body["file"];
        if (!(file instanceof File)) throw new ServiceError(400, "No file provided");
        const bytes = new Uint8Array(await file.arrayBuffer());
        return view(svc, await svc.addAttachment(id(c), file.name, file.type, bytes));
      }),
    );
    api.delete(
      p("/tasks/:id/attachments/:name"),
      requireScope("tasks:write"),
      task(async (svc, c) =>
        view(svc, await svc.removeAttachment(id(c), decodeURIComponent(c.req.param("name")!))),
      ),
    );
    api.get(p("/tasks/:id/attachments/:name"), requireScope("tasks:read"), async (c) => {
      try {
        const svc = await resolveProject(c);
        const { bytes, type } = await svc.getAttachment(
          id(c),
          decodeURIComponent(c.req.param("name")!),
        );
        // Return a native Response: a Uint8Array is a valid BodyInit, sidestepping
        // Hono's c.body() typing which doesn't accept Node Buffers directly.
        return new Response(new Uint8Array(bytes), {
          headers: {
            "Content-Type": type,
            "Cache-Control": "no-cache",
            ...(prefix === "" ? { Deprecation: "true" } : {}),
          },
        });
      } catch (err) {
        const { status, body } = toErrorResponse(err);
        return c.json(body, status as 400);
      }
    });
  };
  registerTaskRoutes("/projects/:pid", projectFromParam);
  registerTaskRoutes("", projectFromDefault);

  // --- Commands ---
  api.get(
    "/commands",
    requireScope("tasks:read"),
    wrap(async () => ({ commands: await service.listCommands() })),
  );
  api.post(
    "/commands",
    requireScope("tasks:write"),
    wrap(async (c) => {
      const { name, body } = await parseJson(c.req, CommandBody);
      return service.upsertCommand(name, body ?? "");
    }),
  );
  api.put(
    "/commands/:id",
    requireScope("tasks:write"),
    wrap(async (c) => {
      const { name, body } = await parseJson(c.req, CommandBody);
      return service.renameCommand(id(c), name, body ?? "");
    }),
  );
  api.delete(
    "/commands/:id",
    requireScope("tasks:write"),
    wrap(async (c) => service.deleteCommand(id(c))),
  );

  // --- Settings / health / usage ---
  api.get(
    "/settings",
    requireScope("settings:read"),
    wrap(async () => service.loadSettings()),
  );
  api.put(
    "/settings",
    requireScope("settings:write"),
    wrap(async (c) => service.updateSettings(await parseJson(c.req, SettingsPatchSchema))),
  );
  api.get(
    "/health",
    requireScope("settings:read"),
    wrap(async () => ({ tools: await service.health() })),
  );
  api.get(
    "/models",
    requireScope("settings:read"),
    wrap(async () => ({ models: await service.listModels() })),
  );
  api.get(
    "/usage",
    requireAnyScope(["projects:read", "tasks:read"]),
    wrap(async (c) => service.totalUsage(allowed(c))),
  );

  // --- Auth administration (never exposes key hashes) ---
  api.get(
    "/auth/clients",
    requireScope("auth:admin"),
    wrap(async () => ({ clients: (await authStore.list()).map(toPublicClient) })),
  );
  api.post(
    "/auth/clients",
    requireScope("auth:admin"),
    wrap(async (c) => {
      const body = await parseJson(c.req, CreateClientBody);
      const me = who(c);
      // Never grant more than you hold.
      const missing = body.scopes.filter((sc) => !hasScope(me, sc));
      if (missing.length > 0) {
        throw new ServiceError(
          403,
          `Cannot grant scopes you do not hold: ${missing.join(", ")}`,
          "forbidden_scope",
          { scopes: missing },
        );
      }
      if (body.trust === "trusted" && me.trust !== "trusted") {
        throw new ServiceError(403, "Cannot grant trusted trust", "forbidden_trust");
      }
      let expiresAt: string | undefined;
      if (body.expiresIn) {
        try {
          expiresAt = new Date(Date.now() + parseDuration(body.expiresIn)).toISOString();
        } catch (err) {
          throw new ServiceError(400, (err as Error).message, "invalid_input");
        }
      }
      return authStore.create({
        name: body.name,
        kind: body.kind,
        scopes: body.scopes,
        projects: body.projects,
        trust: body.trust,
        expiresAt,
      });
    }),
  );
  api.post(
    "/auth/clients/:id/revoke",
    requireScope("auth:admin"),
    wrap(async (c) => {
      const client = await authStore.revoke(id(c));
      if (!client) throw new ServiceError(404, "Client not found");
      return { client };
    }),
  );
  api.post(
    "/auth/clients/:id/rotate",
    requireScope("auth:admin"),
    wrap(async (c) => {
      const out = await authStore.rotate(id(c));
      if (!out) throw new ServiceError(404, "Client not found or revoked");
      return out;
    }),
  );

  // --- SSE live updates ---
  api.get("/events", requireScope("tasks:read"), (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "ready", data: "connected" });
      if (!deps.watcher) {
        // No watcher (e.g. tests): keep the stream open briefly then end.
        return;
      }
      const unsub = deps.watcher.subscribe((event, data) => {
        // A restricted client never hears about projects it may not read.
        if (data.project && !authorizeProject(who(c), data.project)) return;
        void stream.writeSSE({ event, data: JSON.stringify(data) });
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
