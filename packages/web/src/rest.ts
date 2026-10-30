import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  IdempotencyStore,
  OpError,
  toOpError,
  warningsOf,
  type AnyOperation,
  type OpContext,
} from "@boof-runner/api";
import { AuthStore } from "@boof-runner/shared";
import type { ResolveHost, TaskService, UploadedFile } from "@boof-runner/api";

/** Unversioned routes are removed after this date (sent as the `Sunset` header). */
export const LEGACY_SUNSET = "Wed, 30 Jun 2027 00:00:00 GMT";

/** Old unversioned path parameter names, kept so audit lines and the routes do not change. */
const LEGACY_PARAM: Record<string, string> = {
  projectId: "pid",
  taskId: "id",
  commandId: "id",
  clientId: "id",
  webhookId: "id",
  attachmentName: "name",
};

export interface RestDeps {
  service: TaskService;
  authStore: AuthStore;
  idempotency: IdempotencyStore;
  isSelfUrl?: (url: URL) => boolean;
  resolveHost?: ResolveHost;
}

type FieldKind = "boolean" | "number" | "string";

/** Query strings are text: remember which input fields must be turned into booleans/numbers. */
function fieldKinds(op: AnyOperation): Map<string, FieldKind> {
  const schema = z.toJSONSchema(op.input, { io: "input", unrepresentable: "any" }) as {
    properties?: Record<string, { type?: string }>;
  };
  const out = new Map<string, FieldKind>();
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    out.set(
      k,
      v.type === "boolean"
        ? "boolean"
        : v.type === "integer" || v.type === "number"
          ? "number"
          : "string",
    );
  }
  return out;
}

function coerce(kind: FieldKind | undefined, value: string): unknown {
  if (kind === "boolean") {
    if (value === "1" || value === "true") return true;
    if (value === "0" || value === "false") return false;
    return value; // fails validation with a readable message
  }
  if (kind === "number") return value.trim() === "" ? value : Number(value);
  return value;
}

/** `Boof-Warning: status_downgraded` when the result carries warnings. */
function setWarningHeader(c: Context, result: unknown): void {
  const codes = [...new Set(warningsOf(result).map((w) => w.code))];
  if (codes.length > 0) c.header("Boof-Warning", codes.join(", "));
}

function parseIfMatch(header: string, field: "expectedVersion" | "expectedUpdated"): unknown {
  if (field === "expectedVersion") {
    const m = /^\s*(?:W\/)?"?(\d+)"?\s*$/.exec(header);
    if (!m) throw new OpError(400, 'If-Match must be a plan version such as "3"', "invalid_input");
    return Number(m[1]);
  }
  const m = /^\s*(?:W\/)?"(.*)"\s*$/.exec(header);
  if (!m)
    throw new OpError(
      400,
      'If-Match must be a task ETag such as W/"2026-10-01T00:00:00.000Z"',
      "invalid_input",
    );
  return m[1];
}

const JSON_TYPE = /^application\/([\w.-]+\+)?json\s*(;.*)?$/i;

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  const type = (c.req.header("content-type") ?? "").trim();
  if (!JSON_TYPE.test(type)) {
    throw new OpError(
      415,
      "A JSON body needs Content-Type: application/json",
      "unsupported_media_type",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new OpError(400, "Request body must be valid JSON", "invalid_input");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new OpError(400, "Request body must be a JSON object", "invalid_input");
  }
  return raw as Record<string, unknown>;
}

const honoPath = (path: string, legacy: boolean) =>
  path.replace(
    /\{(\w+)\}/g,
    (_m, name: string) => `:${legacy ? (LEGACY_PARAM[name] ?? name) : name}`,
  );

export interface MountOptions {
  /** `/api/v1` or `/api` (the deprecated unversioned routes). */
  prefix: string;
  legacy: boolean;
}

/**
 * Mount `ops` on `app` under `opts.prefix`: one Hono route per operation, built from its `rest`
 * spec. The unversioned mount additionally exposes the task operations at `/tasks…` for the
 * project named by `settings.defaultProject`.
 */
export function mountOps(
  app: Hono,
  ops: readonly AnyOperation[],
  deps: RestDeps,
  opts: MountOptions,
): void {
  for (const op of ops) {
    register(app, op, deps, opts, false);
    if (opts.legacy && op.rest.path.startsWith("/projects/{projectId}/tasks")) {
      register(app, op, deps, opts, true);
    }
  }
}

function register(app: Hono, op: AnyOperation, deps: RestDeps, opts: MountOptions, alias: boolean) {
  const { legacy } = opts;
  const path = alias ? op.rest.path.replace("/projects/{projectId}", "") : op.rest.path;
  const shapeKeys = Object.keys((op.input as z.ZodObject).shape);
  const bodyKeys = shapeKeys.filter((k) => !op.pathParams.includes(k));
  const kinds = fieldKinds(op);
  const method = op.rest.method;
  const readsQuery = method === "GET" || method === "DELETE";

  app.on(method, opts.prefix + honoPath(path, legacy), async (c) => {
    const principal = c.get("principal");
    op.assertScope(principal);

    const params: Record<string, unknown> = {};
    for (const p of op.pathParams) {
      params[p] = c.req.param(legacy ? (LEGACY_PARAM[p] ?? p) : p);
    }
    if (alias) {
      const pid = (await deps.service.loadSettings()).defaultProject;
      if (!pid) {
        throw new OpError(
          404,
          "No default project is set; use /api/projects/:pid/tasks",
          "no_default_project",
        );
      }
      params["projectId"] = pid;
    }

    let input: Record<string, unknown> = {};
    if (op.rest.kind === "multipart") {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (file instanceof File) {
        input["file"] = {
          name: file.name,
          type: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        };
      }
    } else if (readsQuery) {
      for (const k of bodyKeys) {
        const v = c.req.query(k);
        if (v !== undefined) input[k] = coerce(kinds.get(k), v);
      }
    } else if (bodyKeys.length > 0) {
      input = await readBody(c);
    }
    input = { ...input, ...params };

    if (op.rest.ifMatch) {
      const header = c.req.header("If-Match");
      if (header !== undefined && header.trim() !== "*") {
        input[op.rest.ifMatch] = parseIfMatch(header, op.rest.ifMatch);
      }
    }

    const ctx: OpContext = {
      root: deps.service.root,
      principal,
      services: deps.service,
      authStore: deps.authStore,
      now: () => new Date().toISOString(),
      legacy,
      isSelfUrl: deps.isSelfUrl,
      resolveHost: deps.resolveHost,
      audit: (extra) => c.set("auditExtra", extra),
    };

    // Idempotency-Key: replay the stored response for a repeated key.
    const key = op.rest.idempotent ? c.req.header("Idempotency-Key") : undefined;
    if (key !== undefined && !/^[\x21-\x7e]{1,255}$/.test(key)) {
      throw new OpError(400, "Idempotency-Key must be 1-255 printable characters", "invalid_input");
    }
    const run = async () => {
      try {
        return await op.execute(ctx, input);
      } catch (err) {
        throw toOpError(err);
      }
    };
    const shape = (out: unknown) => ({
      status: legacy ? 200 : (op.rest.status ?? 200),
      body: legacy && op.rest.legacyOutput ? op.rest.legacyOutput(out as never) : out,
      etag: op.rest.etag?.(out as never),
    });

    if (key !== undefined) {
      const { file, ...rest } = input;
      const fingerprint =
        op.rest.kind === "multipart"
          ? IdempotencyStore.fingerprintUpload(
              (file as UploadedFile | undefined) ?? { name: "", type: "", bytes: new Uint8Array() },
              rest,
            )
          : IdempotencyStore.fingerprint(input);
      const { record, replayed } = await deps.idempotency.withKey(
        principal.id,
        op.name,
        key,
        fingerprint,
        async () => shape(await run()),
      );
      if (replayed) c.header("Idempotency-Replayed", "true");
      if (record.etag) c.header("ETag", record.etag);
      setWarningHeader(c, record.body);
      return c.json(record.body as object, record.status as 200);
    }

    const out = await run();

    if (op.rest.kind === "binary") {
      const file = out as { bytes: Uint8Array; type: string };
      return c.body(file.bytes as unknown as ArrayBuffer, 200, {
        "Content-Type": file.type,
        "Cache-Control": "no-cache",
      });
    }
    if (op.rest.text && input["format"] === "text") {
      c.header("Cache-Control", "no-cache");
      return c.text(op.rest.text(out as never), 200);
    }
    const { status, body, etag } = shape(out);
    if (etag) c.header("ETag", etag);
    setWarningHeader(c, out);
    return c.json(body as object, status as 200);
  });
}
