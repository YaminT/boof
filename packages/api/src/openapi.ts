import { z } from "zod";
import {
  ClientSchema,
  GoalInputSchema,
  BoofEventSchema,
  GoalSchema,
  PlanSchema,
  ProjectSchema,
  TaskFrontmatterSchema,
  TokenUsageSchema,
} from "@boof-runner/shared";
import type { AnyOperation } from "./define-op.js";
import { ERROR_CODES } from "./errors.js";
import { PublicSettingsSchema, TaskViewSchema } from "./schemas.js";

type Json = Record<string, unknown>;

/** Recursively sort object keys so the document is byte-stable (arrays keep their order). */
export function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeys) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Json)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    ) as T;
  }
  return value;
}

function toSchema(schema: z.ZodType, io: "input" | "output"): Json {
  const json = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Json;
  delete json["$schema"];
  return json;
}

/**
 * Big schemas that many operations share: written once under components.schemas and referenced.
 * Order matters: a later one may contain an earlier one.
 */
const SHARED: [string, z.ZodType, "input" | "output"][] = [
  ["TokenUsage", TokenUsageSchema, "output"],
  ["Goal", GoalSchema, "output"],
  ["GoalInput", GoalInputSchema, "input"],
  ["TaskFrontmatter", TaskFrontmatterSchema, "output"],
  ["Plan", PlanSchema, "output"],
  ["Task", TaskViewSchema, "output"],
  ["Project", ProjectSchema, "output"],
  ["Client", ClientSchema.omit({ keyHash: true }), "output"],
  ["Settings", PublicSettingsSchema, "output"],
];

function replaceShared(node: unknown, shared: [string, string][]): unknown {
  if (Array.isArray(node)) return node.map((n) => replaceShared(n, shared));
  if (node && typeof node === "object") {
    const text = JSON.stringify(node);
    const hit = shared.find(([, json]) => json === text);
    if (hit) return { $ref: `#/components/schemas/${hit[0]}` };
    return Object.fromEntries(
      Object.entries(node as Json).map(([k, v]) => [k, replaceShared(v, shared)]),
    );
  }
  return node;
}

const FILE_SCHEMA: Json = { type: "string", format: "binary" };

function operationObject(op: AnyOperation): Json {
  const input = toSchema(op.input, "input") as {
    properties?: Record<string, Json>;
    required?: string[];
  };
  const props = input.properties ?? {};
  const required = new Set(input.required ?? []);
  const rest = op.rest;
  const parameters: Json[] = [];

  for (const name of op.pathParams) {
    parameters.push({
      name,
      in: "path",
      required: true,
      schema: props[name] ?? { type: "string" },
    });
  }
  const others = Object.keys(props).filter((k) => !op.pathParams.includes(k));
  const hasBody = (rest.method === "POST" || rest.method === "PUT") && others.length > 0;
  if (rest.method === "GET" || rest.method === "DELETE") {
    for (const name of others) {
      parameters.push({
        name,
        in: "query",
        required: required.has(name),
        schema: props[name],
      });
    }
  }
  if (rest.ifMatch) {
    parameters.push({
      name: "If-Match",
      in: "header",
      required: false,
      description:
        rest.ifMatch === "expectedVersion"
          ? 'The plan version you last saw, e.g. "3". A newer stored version answers 409 plan_version_conflict.'
          : 'The task ETag you last saw, e.g. W/"2026-10-01T00:00:00.000Z". A newer task answers 409 task_modified.',
      schema: { type: "string" },
    });
  }
  if (rest.idempotent) {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: false,
      description:
        "Repeat the request with the same key within 24 hours and get the original response (header Idempotency-Replayed: true).",
      schema: { type: "string", maxLength: 255 },
    });
  }

  const out: Json = {
    operationId: op.name,
    summary: op.title,
    description: op.description,
    tags: [op.name.split(".")[0]],
    "x-boof-scope": op.scopes.length === 1 ? op.scopes[0] : { anyOf: op.scopes },
    ...(op.mcp.expose && op.mcp.name ? { "x-mcp-tool": op.mcp.name } : {}),
    parameters,
  };

  if (rest.kind === "multipart") {
    out["requestBody"] = {
      required: true,
      content: {
        "multipart/form-data": {
          schema: {
            type: "object",
            properties: { file: FILE_SCHEMA },
            required: ["file"],
          },
        },
      },
    };
  } else if (hasBody) {
    const bodyProps = Object.fromEntries(others.map((k) => [k, props[k]]));
    const bodyRequired = others.filter((k) => required.has(k));
    out["requestBody"] = {
      required: bodyRequired.length > 0,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: bodyProps,
            ...(bodyRequired.length ? { required: bodyRequired } : {}),
            additionalProperties: false,
          },
        },
      },
    };
  }

  const okHeaders: Json = {};
  if (rest.etag) okHeaders["ETag"] = { schema: { type: "string" } };
  out["responses"] = {
    [String(rest.status ?? 200)]: {
      description: "Success",
      ...(Object.keys(okHeaders).length ? { headers: okHeaders } : {}),
      content:
        rest.kind === "binary"
          ? { "application/octet-stream": { schema: FILE_SCHEMA } }
          : { "application/json": { schema: toSchema(op.output, "output") } },
    },
    default: {
      description: "Error",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    },
  };
  return out;
}

/** The OpenAPI 3.1 document of the v1 REST API, generated from the operations registry. */
export function buildOpenApi(ops: readonly AnyOperation[]): Json {
  const paths: Record<string, Record<string, Json>> = {};
  for (const op of ops) {
    (paths[op.rest.path] ??= {})[op.rest.method.toLowerCase()] = operationObject(op);
  }
  paths["/events"] = {
    get: {
      operationId: "events.stream",
      summary: "Stream events (SSE)",
      description:
        "Server-Sent Events of task, plan and runner changes, plus ephemeral `event: changed` hints (data {project}) for file changes that are not events; hints have no id and are not replayed. Each event has `event: <type>`, `id: <cursor>` and the event JSON as data. Reconnect with Last-Event-ID (or since=<cursor>) to replay what you missed; since=start replays everything; without it only new events arrive. Needs tasks:read; only projects the client may access are sent.",
      tags: ["events"],
      "x-boof-scope": "tasks:read",
      parameters: [
        { name: "project", in: "query", required: false, schema: { type: "string" } },
        { name: "since", in: "query", required: false, schema: { type: "string" } },
        { name: "Last-Event-ID", in: "header", required: false, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "An event stream.",
          content: { "text/event-stream": { schema: { $ref: "#/components/schemas/Event" } } },
        },
        default: {
          description: "Error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    },
  };
  const shared: [string, string][] = SHARED.map(([name, schema, io]) => [
    name,
    JSON.stringify(sortKeys(toSchema(schema, io))),
  ]);
  const shapes: Record<string, unknown> = {};
  shared.forEach(([name, json], i) => {
    shapes[name] = replaceShared(JSON.parse(json), shared.slice(0, i));
  });
  return sortKeys({
    openapi: "3.1.0",
    info: {
      title: "Boof Runner API",
      version: "1.0.0",
      description:
        "Queue prompts, plans and goals for the boof-runner agent pipeline. Authenticate with a bearer API key; see docs/api.md.",
    },
    servers: [{ url: "/api/v1" }],
    security: [{ bearerAuth: [] }],
    paths: replaceShared(sortKeys(paths), shared),
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        ...shapes,
        Event: toSchema(BoofEventSchema, "output"),
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", enum: Object.keys(ERROR_CODES) },
                message: { type: "string" },
                details: {},
              },
            },
          },
        },
      },
    },
    "x-error-codes": Object.fromEntries(
      Object.entries(ERROR_CODES).map(([code, [status, description]]) => [
        code,
        { status, description },
      ]),
    ),
  });
}
