/**
 * The generated CLI: every operation of the registry as `boof-runner <area> <verb>`. This half is
 * pure: command paths and argument parsing. Execution is in the second half of the file.
 */
import { readFileSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { registry, type AnyOperation } from "@boof-runner/api";
import { CliUsageError } from "./epic-cli.js";

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/** "plans.replaceGoals" → ["plans", "replace-goals"]; "auth.clients.revoke" → ["auth", "clients", "revoke"]. */
export function commandPath(op: AnyOperation): string[] {
  return op.name.split(".").map(kebab);
}

/** Operations with a generated command (not `cli.hidden`). */
export function cliOps(ops: readonly AnyOperation[] = registry): AnyOperation[] {
  return ops.filter((o) => !o.cli?.hidden);
}

/** Longest leading run of argv words that names an operation. */
export function matchOpCommand(
  argv: string[],
  ops: readonly AnyOperation[] = registry,
): { op: AnyOperation; rest: string[] } | undefined {
  const all = cliOps(ops);
  for (let n = Math.min(3, argv.length); n >= 1; n--) {
    const key = argv.slice(0, n).join(" ");
    const op = all.find((o) => commandPath(o).join(" ") === key);
    if (op) return { op, rest: argv.slice(n) };
  }
  return undefined;
}

/** True when `word` is the first word of some generated command ("tasks", "auth", "runner"). */
export function isOpArea(word: string, ops: readonly AnyOperation[] = registry): boolean {
  return cliOps(ops).some((o) => commandPath(o)[0] === word);
}

/** Hand-written top-level commands and their subcommands; a generated path must not shadow one. */
export const HAND_WRITTEN_COMMANDS: Record<string, readonly string[]> = {
  serve: [],
  run: [],
  scan: [],
  project: ["add", "list", "remove"],
  epic: ["add", "list", "archive", "remove"],
  task: ["list", "move"],
  plan: ["import", "sync", "export"],
  auth: ["add", "list", "revoke", "rotate"],
  remote: ["setup", "status", "disable"],
  service: ["install", "uninstall", "status", "logs"],
  mcp: [],
};

/** Flags the CLI owns; no input field may kebab-case to one of them. */
export const RESERVED_FLAGS: readonly string[] = [
  "data",
  "client",
  "json",
  "input",
  "help",
  "project",
  "out",
];

export interface ParsedOpArgs {
  input: Record<string, unknown>;
  json: boolean;
  help: boolean;
  data?: string;
  client?: string;
  out?: string;
}

type Kind = "boolean" | "number" | "string" | "stringList" | "stringOrList" | "json";
interface FieldKind {
  kind: Kind;
  nullable: boolean;
}
type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
};

const alternatives = (node: JsonSchema): JsonSchema[] => {
  const out: JsonSchema[] = [];
  for (const m of node.anyOf ?? node.oneOf ?? [node]) {
    if (m.anyOf || m.oneOf) out.push(...alternatives(m));
    else if (Array.isArray(m.type)) out.push(...m.type.map((t) => ({ type: t })));
    else out.push(m);
  }
  return out;
};

const isStringish = (m: JsonSchema) =>
  m.type === "string" || typeof m.const === "string" || (m.enum !== undefined && m.type !== "null");
const isStringList = (m: JsonSchema) =>
  m.type === "array" && m.items !== undefined && alternatives(m.items).every(isStringish);

function fieldKind(node: JsonSchema): FieldKind {
  const all = alternatives(node);
  const nullable = all.some((m) => m.type === "null");
  const ms = all.filter((m) => m.type !== "null");
  const kind = (k: Kind): FieldKind => ({ kind: k, nullable });
  if (ms.length > 0 && ms.every((m) => m.type === "boolean")) return kind("boolean");
  if (ms.length > 0 && ms.every((m) => m.type === "integer" || m.type === "number")) {
    return kind("number");
  }
  if (ms.length > 0 && ms.every(isStringish)) return kind("string");
  if (ms.length > 0 && ms.every(isStringList)) return kind("stringList");
  if (ms.length > 0 && ms.every((m) => isStringish(m) || isStringList(m))) {
    return kind("stringOrList");
  }
  return kind("json");
}

interface Flag {
  key: string;
  field: FieldKind;
}

function flagsOf(op: AnyOperation): Map<string, Flag> {
  const schema = z.toJSONSchema(op.input, { io: "input", unrepresentable: "any" }) as JsonSchema;
  const out = new Map<string, Flag>();
  for (const [key, node] of Object.entries(schema.properties ?? {})) {
    const flag = { key, field: fieldKind(node) };
    out.set(kebab(key), flag);
    if (key === "projectId") out.set("project", flag);
  }
  return out;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

function readJsonText(flag: string, text: string, cwd: string): unknown {
  let raw = text;
  if (text.startsWith("@")) {
    const path = text.slice(1);
    try {
      raw = readFileSync(isAbsolute(path) ? path : resolve(cwd, path), "utf8");
    } catch (e) {
      throw new CliUsageError(`--${flag}: ${(e as Error).message}`);
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliUsageError(`--${flag}: not valid JSON`);
  }
}

function coerce(
  flag: string,
  f: FieldKind,
  value: string,
  cwd: string,
  previous: unknown,
): unknown {
  switch (f.kind) {
    case "boolean":
      if (value === "1" || value === "true") return true;
      if (value === "0" || value === "false") return false;
      return value; // the schema reports it
    case "number": {
      const n = Number(value);
      return value.trim() === "" || Number.isNaN(n) ? value : n;
    }
    case "string":
      return f.nullable && value === "null" ? null : value;
    case "stringList":
    case "stringOrList": {
      if (value.startsWith("[")) return readJsonText(flag, value, cwd);
      if (f.kind === "stringOrList" && !value.includes(",") && previous === undefined) {
        return value === "*" ? "*" : [value];
      }
      const items = value.split(",").filter((s) => s !== "");
      return Array.isArray(previous) ? [...previous, ...items] : items;
    }
    case "json":
      return readJsonText(flag, value, cwd);
  }
}

/** Throws CliUsageError on an unknown flag, a positional, or bad JSON. */
export function parseOpArgs(
  op: AnyOperation,
  rest: string[],
  cwd: string = process.cwd(),
): ParsedOpArgs {
  const flags = flagsOf(op);
  const result: ParsedOpArgs = { input: {}, json: false, help: false };
  let base: Record<string, unknown> = {};
  const given: Record<string, unknown> = {};
  const OWN_VALUE = new Set(["data", "client", "out", "input"]);

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (token === "-h" || token === "--help") {
      result.help = true;
      continue;
    }
    if (token === "-d" || token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = token === "-d" ? "data" : token.slice(2, eq > 0 ? eq : undefined);
      const inline = eq > 0 ? token.slice(eq + 1) : undefined;
      const takeValue = (flag: string): string => {
        if (inline !== undefined) return inline;
        if (i + 1 >= rest.length) throw new CliUsageError(`--${flag} needs a value`);
        i += 1;
        return rest[i]!;
      };
      if (name === "json") {
        result.json = inline === undefined ? true : inline !== "false" && inline !== "0";
        continue;
      }
      if (OWN_VALUE.has(name)) {
        const v = takeValue(name);
        if (name === "input") {
          const parsed = readJsonText("input", v, cwd);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new CliUsageError("--input: must be a JSON object");
          }
          base = parsed as Record<string, unknown>;
        } else {
          result[name as "data" | "client" | "out"] = v;
        }
        continue;
      }
      const negated = name.startsWith("no-") && flags.get(name.slice(3))?.field.kind === "boolean";
      const flag = flags.get(negated ? name.slice(3) : name);
      if (!flag) throw new CliUsageError(`unknown option --${name}`);
      const f = flag.field;
      if (op.rest.kind === "multipart" && flag.key === "file") {
        const path = takeValue(name);
        try {
          const abs = isAbsolute(path) ? path : resolve(cwd, path);
          given[flag.key] = {
            name: basename(abs),
            type: MIME[extname(abs).toLowerCase()] ?? "application/octet-stream",
            bytes: new Uint8Array(readFileSync(abs)),
          };
        } catch (e) {
          throw new CliUsageError(`--${name}: ${(e as Error).message}`);
        }
        continue;
      }
      if (f.kind === "boolean") {
        if (negated) given[flag.key] = false;
        else if (inline !== undefined) given[flag.key] = coerce(name, f, inline, cwd, undefined);
        else given[flag.key] = true;
        continue;
      }
      given[flag.key] = coerce(name, f, takeValue(name), cwd, given[flag.key]);
      continue;
    }
    throw new CliUsageError(`unexpected argument "${token}"`);
  }
  result.input = { ...base, ...given };
  return result;
}
