/**
 * Generates two things from the operations registry:
 *
 *  1. The REST reference inside docs/harness.md, between the markers
 *     `<!-- BEGIN GENERATED REFERENCE -->` and `<!-- END GENERATED REFERENCE -->`.
 *  2. packages/web/src/generated/harness.ts, the doc as a string constant the server embeds
 *     (so it works unchanged under tsx, vitest, the tsup CLI bundle and the desktop bundle).
 *
 * Run `npx tsx scripts/gen-harness-reference.ts` after editing docs/harness.md or any operation.
 * `packages/web/src/harness.test.ts` fails when either output is stale.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { buildOpenApi, getOp, registry } from "../packages/api/src/index.js";
import { SCOPES } from "../packages/shared/src/index.js";

export const BEGIN = "<!-- BEGIN GENERATED REFERENCE -->";
export const END = "<!-- END GENERATED REFERENCE -->";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const HARNESS_MD = join(ROOT, "docs", "harness.md");
export const HARNESS_TS = join(ROOT, "packages", "web", "src", "generated", "harness.ts");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// --- JSON schema -> compact type text ---

const KEBAB = "^[a-z0-9]+(-[a-z0-9]+)*$";

function typeText(s: Json | undefined, depth = 0): string {
  if (!s) return "any";
  if (s["$ref"]) return String(s["$ref"]).split("/").pop()!;
  if (s["const"] !== undefined) return JSON.stringify(s["const"]);
  if (s["enum"] && JSON.stringify(s["enum"]) === JSON.stringify(SCOPES)) return "Scope";
  if (s["enum"]) return (s["enum"] as unknown[]).map((v) => JSON.stringify(v)).join(" | ");
  const alt = (s["anyOf"] ?? s["oneOf"]) as Json[] | undefined;
  if (alt) return alt.map((a) => typeText(a, depth)).join(" | ");
  const t = s["type"];
  if (Array.isArray(t)) return t.map((x) => typeText({ ...s, type: x }, depth)).join(" | ");
  if (t === "array") return `${wrap(typeText(s["items"], depth))}[]`;
  if (t === "string") {
    if (s["pattern"] === KEBAB) return "kebab-id";
    if (s["format"] === "date-time") return "ISO-8601 string";
    if (s["format"] === "binary") return "binary";
    return "string";
  }
  if (t === "integer" || t === "number") {
    const big = (v: unknown) => typeof v === "number" && Math.abs(v) > 1e12;
    const lo = big(s["minimum"]) ? undefined : s["minimum"];
    const hi = big(s["maximum"]) ? undefined : s["maximum"];
    const base = t === "integer" ? "integer" : "number";
    if (lo !== undefined && hi !== undefined) return `${base} ${lo}..${hi}`;
    if (lo !== undefined) return `${base} >= ${lo}`;
    if (hi !== undefined) return `${base} <= ${hi}`;
    return base;
  }
  if (t === "boolean") return "boolean";
  if (t === "null") return "null";
  if (t === "object" || s["properties"] || s["additionalProperties"]) {
    const props = (s["properties"] ?? {}) as Record<string, Json>;
    const names = Object.keys(props);
    if (names.length === 0) {
      const ap = s["additionalProperties"];
      return ap && typeof ap === "object" ? `{ [key: string]: ${typeText(ap, depth)} }` : "object";
    }
    if (depth >= 2) return "object";
    const req = new Set((s["required"] ?? []) as string[]);
    return `{ ${names
      .map((n) => `${n}${req.has(n) ? "" : "?"}: ${typeText(props[n], depth + 1)}`)
      .join(", ")} }`;
  }
  return "any";
}

const wrap = (t: string) => (/[ |]/.test(t) && !t.startsWith("{") ? `(${t})` : t);

const code = (t: string) => "`" + t.replace(/`/g, "'") + "`";

/** Constraint and default notes for a field schema. */
function notes(s: Json): string {
  const out: string[] = [];
  if (s["default"] !== undefined) out.push(`default ${code(JSON.stringify(s["default"]))}`);
  if (s["description"]) out.push(String(s["description"]).replace(/\.$/, ""));
  const t = s["type"];
  if (t === "string") {
    if (s["minLength"] !== undefined && s["minLength"] > 1)
      out.push(`min length ${s["minLength"]}`);
    if (s["maxLength"] !== undefined && s["pattern"] !== KEBAB)
      out.push(`max length ${s["maxLength"]}`);
  }
  if (t === "array") {
    if (s["minItems"] !== undefined) out.push(`min ${s["minItems"]} item(s)`);
    if (s["maxItems"] !== undefined) out.push(`max ${s["maxItems"]} item(s)`);
  }
  return out.join("; ");
}

function fieldTable(props: Record<string, Json>, required: Set<string>): string[] {
  return Object.entries(props).map(([name, schema]) => {
    const extra = notes(schema);
    return `- ${code(name)}: ${code(typeText(schema))}, ${required.has(name) ? "required" : "optional"}${extra ? `; ${extra}` : ""}`;
  });
}

// --- Per-operation facts ---

/** Errors an operation can raise beyond the generic ones; every code is in ERROR_CODES. */
const EXTRA_ERRORS: Record<string, string[]> = {
  "projects.create": [
    "400 not_a_git_repo",
    "403 project_root_not_allowed",
    "409 project_exists",
    "409 conflict",
  ],
  "projects.update": ["400 not_a_git_repo", "403 project_root_not_allowed"],
  "projects.delete": ["409 project_busy"],
  "plans.create": ["409 plan_exists"],
  "plans.update": ["403 forbidden_trust"],
  "plans.replaceGoals": ["403 forbidden_trust"],
  "plans.upsertGoal": ["403 forbidden_trust"],
  "plans.removeGoal": ["403 forbidden_trust", "404 goal_not_found", "409 goal_has_dependents"],
  "plans.reorderGoals": ["403 forbidden_trust"],
  "plans.setGoalStatus": ["403 forbidden_trust", "404 goal_not_found"],
  "plans.import": ["400 nothing_to_import", "403 forbidden_trust", "409 plan_exists"],
  "plans.sync": ["409 plan_not_active"],
  "tasks.get": ["404 not_found"],
  "tasks.update": ["403 forbidden_trust", "404 not_found", "409 invalid_transition"],
  "tasks.queue": ["403 forbidden_trust", "404 not_found", "409 invalid_transition"],
  "tasks.retry": ["403 forbidden_trust", "404 not_found", "409 invalid_transition"],
  "tasks.unarchive": ["403 forbidden_trust", "404 not_found", "409 invalid_transition"],
  "tasks.archive": ["404 not_found", "409 invalid_transition"],
  "tasks.answers": ["403 forbidden_trust", "404 not_found", "409 invalid_transition"],
  "tasks.delete": ["404 not_found", "400 invalid_input (the task is running)"],
  "tasks.stop": ["404 not_found", "400 invalid_input (the task is not running)"],
  "tasks.inject": ["404 not_found", "400 invalid_input (the task is not running)"],
  "tasks.liveLog": ["404 not_found"],
  "tasks.wait": ["404 not_found"],
  "tasks.skip": ["404 not_found"],
  "auth.clients.create": ["403 forbidden_trust"],
  "auth.clients.revoke": ["404 not_found"],
  "auth.clients.rotate": ["404 not_found"],
  "webhooks.delete": ["404 not_found"],
  "webhooks.create": ["400 invalid_input (bad URL, URL is this server, unknown event)"],
};

function errorsFor(opName: string): string[] {
  const op = getOp(opName)!;
  const list: string[] = [];
  if (op.scopes.length > 0) list.push("403 forbidden_scope");
  if (op.projectScoped) list.push("403 forbidden_project", "404 project_not_found");
  const shape = (op.input as { shape: Record<string, unknown> }).shape;
  if ("planId" in shape && op.name !== "plans.import") list.push("404 plan_not_found");
  const invalid = op.invalidInputCode ?? "invalid_input";
  if (Object.keys(shape).length > 0) list.push(`400 ${invalid}`);
  if (op.rest.ifMatch === "expectedVersion") list.push("409 plan_version_conflict");
  if (op.rest.ifMatch === "expectedUpdated") list.push("409 task_modified");
  if (op.rest.idempotent) list.push("409 idempotency_conflict");
  list.push(...(EXTRA_ERRORS[op.name] ?? []));
  return [...new Set(list)];
}

const scopeText = (op: ReturnType<typeof getOp> & object): string =>
  op.scopes.length === 0
    ? "none (any authenticated caller)"
    : op.scopes.length === 1
      ? code(op.scopes[0])
      : `any one of ${op.scopes.map(code).join(", ")}`;

function operationSection(opName: string, method: string, path: string, o: Json): string[] {
  const op = getOp(opName)!;
  const params = (o["parameters"] ?? []) as Json[];
  const pathParams = params.filter((p) => p["in"] === "path");
  const query = params.filter((p) => p["in"] === "query");
  const headers = params.filter((p) => p["in"] === "header");
  const body = o["requestBody"]?.["content"] as Json | undefined;
  const out: string[] = [];
  out.push(`#### ${code(`${method.toUpperCase()} /api/v1${path}`)} (${op.title})`, "");
  out.push(`- Operation: ${code(opName)}`);
  out.push(`- Scope: ${scopeText(op)}`);
  out.push(`- MCP tool: ${op.mcp.expose ? code(op.mcp.name!) : "none (REST only)"}`);
  out.push(`- What it does: ${op.description}`);
  const ok = Object.entries((o["responses"] ?? {}) as Json).find(([k]) => k !== "default");
  const okSchema = ok?.[1]?.["content"];
  const etag = ok?.[1]?.["headers"]?.["ETag"] ? " The response has an `ETag` header." : "";
  const respType = okSchema?.["application/octet-stream"]
    ? "binary file"
    : okSchema?.["application/json"]
      ? code(typeText(okSchema["application/json"]["schema"]))
      : "empty";
  out.push(`- Success: HTTP ${ok?.[0] ?? "200"} with ${respType}.${etag}`);
  for (const h of headers) {
    out.push(`- Header ${code(h["name"])}: ${h["description"] ?? ""}`);
  }
  out.push(`- Errors: ${errorsFor(opName).map(code).join(", ") || "none beyond the generic ones"}`);
  if (pathParams.length > 0) {
    out.push("", "Path parameters (all required):", "");
    out.push(
      ...fieldTable(
        Object.fromEntries(pathParams.map((p) => [p["name"], p["schema"]])),
        new Set(pathParams.map((p) => p["name"])),
      ),
    );
  }
  if (query.length > 0) {
    out.push("", "Query parameters:", "");
    out.push(
      ...fieldTable(
        Object.fromEntries(query.map((p) => [p["name"], p["schema"]])),
        new Set(query.filter((p) => p["required"]).map((p) => p["name"])),
      ),
    );
  }
  const json = body?.["application/json"]?.["schema"] as Json | undefined;
  if (json) {
    out.push("", "JSON body (unknown keys are rejected):", "");
    out.push(...fieldTable(json["properties"] ?? {}, new Set(json["required"] ?? [])));
    if (Object.keys(json["properties"] ?? {}).length === 0) out.push("- (no fields)");
  } else if (body?.["multipart/form-data"]) {
    out.push("", "Multipart body: one field `file` (image or PDF, at most 25 MB).");
  }
  out.push("");
  return out;
}

function sharedSection(name: string, schema: Json): string[] {
  return [
    `#### ${code(name)}`,
    "",
    ...fieldTable(schema["properties"] ?? {}, new Set(schema["required"] ?? [])),
    "",
  ];
}

const AREA_TITLE: Record<string, string> = {
  auth: "Identity and API clients",
  projects: "Projects",
  plans: "Plans and goals",
  tasks: "Tasks",
  actions: "Actions (parked tasks)",
  settings: "Settings",
  runner: "Runner",
  usage: "Usage",
  commands: "Command templates",
  webhooks: "Webhooks (admin)",
};

/** The generated reference as markdown (not yet formatted by prettier). */
export function renderReference(): string {
  const doc = buildOpenApi(registry) as Json;
  const paths = doc["paths"] as Record<string, Record<string, Json>>;
  const byOp = new Map<string, { method: string; path: string; o: Json }>();
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, o] of Object.entries(item)) {
      if (o["operationId"] !== "events.stream") {
        byOp.set(o["operationId"], { method, path, o });
      }
    }
  }
  const out: string[] = [];
  out.push(
    "This section is generated from the operations registry. Do not edit it by hand.",
    "",
    `There are ${registry.length} operations. Every path below starts with ${code("/api/v1")}.`,
    "Every operation can also fail with `401 unauthenticated`, `413 payload_too_large`, `421 host_not_allowed`, `429 rate_limited` and `500 internal`.",
    "",
    "### Shared object shapes",
    "",
    "Types named below: `kebab-id` is a string that matches `^[a-z0-9]+(-[a-z0-9]+)*$`.",
    `\`Scope\` is one of ${SCOPES.map((x) => code(x)).join(", ")}.`,
    "",
  );
  const schemas = doc["components"]["schemas"] as Record<string, Json>;
  for (const name of [
    "Project",
    "Task",
    "TaskFrontmatter",
    "Plan",
    "Goal",
    "GoalInput",
    "TokenUsage",
    "Client",
  ]) {
    if (schemas[name]) out.push(...sharedSection(name, schemas[name]));
  }
  out.push("### Operations by area", "");
  const areas: string[] = [];
  for (const op of registry) {
    const area = op.name.split(".")[0];
    if (!areas.includes(area)) areas.push(area);
  }
  for (const area of areas) {
    out.push(`### ${AREA_TITLE[area] ?? area}`, "");
    for (const op of registry.filter((x) => x.name.split(".")[0] === area)) {
      const hit = byOp.get(op.name)!;
      out.push(...operationSection(op.name, hit.method, hit.path, hit.o));
    }
  }
  out.push(
    "### Event stream",
    "",
    `#### ${code("GET /api/v1/events")} (Server-Sent Events)`,
    "",
    "- Scope: `tasks:read`",
    "- Query: `project` (kebab-id, optional), `since` (cursor or `start`, optional). Header `Last-Event-ID` (cursor, optional).",
    "- Success: HTTP 200, `text/event-stream`. Each event has `event: <type>`, `id: <cursor>` and the event JSON as `data`.",
    "- Errors: `400 invalid_input` (bad cursor or project id), `403 forbidden_scope`, `403 forbidden_project`, `404 project_not_found`",
    "",
  );
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

async function format(md: string): Promise<string> {
  const config = (await prettier.resolveConfig(join(ROOT, "docs", "harness.md"))) ?? {};
  return prettier.format(md, { ...config, parser: "markdown" });
}

/** Replace the generated section of `md`. Throws when the markers are missing. */
export function spliceReference(md: string, reference: string): string {
  const a = md.indexOf(BEGIN);
  const b = md.indexOf(END);
  if (a === -1 || b === -1 || b < a) throw new Error(`docs/harness.md needs ${BEGIN} and ${END}`);
  return `${md.slice(0, a + BEGIN.length)}\n\n${reference.trim()}\n\n${md.slice(b)}`;
}

/** `docs/harness.md` with an up-to-date, prettier-formatted reference section. */
export async function expectedHarnessMd(current: string): Promise<string> {
  return format(spliceReference(current, renderReference()));
}

/** The module text of packages/web/src/generated/harness.ts for the doc `md`. */
export function embeddedModule(md: string): string {
  return `// Generated by scripts/gen-harness-reference.ts from docs/harness.md. Do not edit.\nexport const HARNESS_MD = ${JSON.stringify(md)};\n`;
}

async function main(): Promise<void> {
  const next = await expectedHarnessMd(readFileSync(HARNESS_MD, "utf8"));
  writeFileSync(HARNESS_MD, next);
  writeFileSync(HARNESS_TS, embeddedModule(next));
  console.log(`wrote ${HARNESS_MD} and ${HARNESS_TS}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
