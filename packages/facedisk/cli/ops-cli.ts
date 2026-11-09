/**
 * The generated CLI: every operation of the registry as `boof-runner <area> <verb>`. This half is
 * pure: command paths and argument parsing. Execution is in the second half of the file.
 */
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  LocalPrincipalError,
  localPrincipal,
  OpError,
  registry,
  toOpError,
  warningsOf,
  type AnyOperation,
  type OpContext,
  type TaskService,
} from "@boof/heart-server";
import { AuthStore, isKebabId, scaffoldDataRoot, auditOperation } from "@boof/heart";
import { CliUsageError, dataRootOf } from "./epic-cli.js";

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
  writeOnly?: boolean;
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
  writeOnly?: boolean;
}

function flagsOf(op: AnyOperation): Map<string, Flag> {
  const schema = z.toJSONSchema(op.input, { io: "input", unrepresentable: "any" }) as JsonSchema;
  const out = new Map<string, Flag>();
  for (const [key, node] of Object.entries(schema.properties ?? {})) {
    const flag = { key, field: fieldKind(node), writeOnly: node.writeOnly === true };
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

function readJsonText(
  flag: string,
  text: string,
  cwd: string,
  readStdin: () => string = () => readFileSync(0, "utf8"),
): unknown {
  let raw = text;
  if (text.startsWith("@")) {
    const path = text.slice(1);
    try {
      raw =
        path === "-"
          ? readStdin()
          : readFileSync(isAbsolute(path) ? path : resolve(cwd, path), "utf8");
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

// Webhook URL fields are identified from both the operation namespace and its input schema,
// keeping this CLI-only safeguard tied to the actual webhook URL field.
function isWebhookUrl(op: AnyOperation, key: string): boolean {
  return op.name.startsWith("webhooks.") && key === "url";
}

function hasSecretBearingWebhookUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return true;
    return url.pathname
      .split("/")
      .some((segment) => segment.length >= 16 && /[a-z]/i.test(segment) && /\d/.test(segment));
  } catch {
    return false;
  }
}

function refuseInlineWebhookUrl(key: string): never {
  throw new CliUsageError(
    `--${kebab(key)} looks secret-bearing; pass it with --input @file.json or --input @- to read stdin`,
  );
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
  readStdin?: () => string,
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
          const parsed = readJsonText("input", v, cwd, readStdin);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new CliUsageError("--input: must be a JSON object");
          }
          // Inline JSON is part of argv (visible in `ps` and shell history): a write-only secret
          // may come only from a file or stdin. Name the field, never its value.
          if (!v.startsWith("@")) {
            const inlineInput = parsed as Record<string, unknown>;
            const secret = Object.keys(parsed).find((k) =>
              [...flags.values()].some((f) => f.key === k && f.writeOnly),
            );
            if (secret)
              throw new CliUsageError(
                `--input: "${secret}" is write-only; pass the input with --input @file.json or --input @- to read stdin, not inline`,
              );
            const webhookUrl = Object.keys(parsed).find(
              (k) => isWebhookUrl(op, k) && hasSecretBearingWebhookUrl(inlineInput[k]),
            );
            if (webhookUrl) refuseInlineWebhookUrl(webhookUrl);
          }
          base = parsed as Record<string, unknown>;
        } else {
          result[name as "data" | "client" | "out"] = v;
        }
        continue;
      }
      const negated = name.startsWith("no-") && flags.get(name.slice(3))?.field.kind === "boolean";
      const flag = flags.get(negated ? name.slice(3) : name);
      if (!flag) {
        if (
          [...flags.values()].some(
            (candidate) => kebab(candidate.key) === name && candidate.writeOnly,
          )
        )
          throw new CliUsageError(
            `--${name} is write-only; pass it with --input @file.json or --input @- to read stdin`,
          );
        throw new CliUsageError(`unknown option --${name}`);
      }
      if (flag.writeOnly)
        throw new CliUsageError(
          `--${name} is write-only; pass it with --input @file.json or --input @- to read stdin`,
        );
      if (isWebhookUrl(op, flag.key)) {
        const rawValue = inline ?? rest[i + 1];
        if (hasSecretBearingWebhookUrl(rawValue)) refuseInlineWebhookUrl(flag.key);
      }
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

// --- Running a command ---

export interface OpsIo {
  /** Default console.log. */
  out: (line: string) => void;
  /** Default console.error. */
  err: (line: string) => void;
  /** Default process.stdout.write (a binary result with `--out -`). */
  write: (bytes: Uint8Array) => void;
  /** Whether stdout is a terminal (default `process.stdout.isTTY`); binary output is refused there. */
  stdoutIsTty?: boolean;
}

export interface OpsDeps {
  /** Built by the composition root (bin/src/boof-runner.ts); tests pass a MockTool registry. */
  services: (root: string) => TaskService;
  /** Default: aborted on SIGINT. */
  signal?: AbortSignal;
}

/** Exit code for an operation error: 404 → 2; 401, 403 → 3; anything else → 1. */
export function exitCodeFor(err: OpError): number {
  if (err.status === 404) return 2;
  if (err.status === 401 || err.status === 403) return 3;
  return 1;
}

/** Top-level result fields shown once (client keys, webhook secrets); human mode prints them. */
export const ONE_TIME_SECRET_FIELDS: readonly string[] = ["key", "secret"];

const NO_PROJECT =
  "no project: pass --project <id>, or set a default with `project add <dir> --default`.";

const flagName = (key: string) => kebab(key);

function kindLabel(node: JsonSchema): string {
  const k = fieldKind(node).kind;
  return k === "stringList" || k === "stringOrList" ? "list" : k;
}

function helpFor(op: AnyOperation): string[] {
  const schema = z.toJSONSchema(op.input, { io: "input", unrepresentable: "any" }) as JsonSchema & {
    required?: string[];
  };
  const required = new Set(schema.required ?? []);
  const path = commandPath(op).join(" ");
  const lines = [
    op.title,
    "",
    op.description,
    ...(path.startsWith("accounts ")
      ? [
          "Account pooling by better-ccflare (MIT, © 2025 snipeship & tombii), a fork of ccflare by snipeship.",
        ]
      : []),
    "",
    `Usage: boof-runner ${path} [flags]`,
    `Scope: ${op.scopes.length > 0 ? op.scopes.join(" or ") : "none"}`,
    "",
    "Flags:",
  ];
  for (const [key, node] of Object.entries(schema.properties ?? {})) {
    const description = (node as { description?: string }).description ?? "";
    if (node.writeOnly !== true)
      lines.push(
        `  --${flagName(key)} ${kindLabel(node)}  ${required.has(key) ? "required" : "optional"}  ${description}`.trimEnd(),
      );
  }
  lines.push(
    "  --input <json|@file>  the whole input as JSON (flags override its keys). Put a secret (a",
    "                        webhook URL) in a file and pass --input @file.json: a command line",
    "                        shows in shell history and in `ps`.",
    "  --json                print the result as JSON",
    "  --client <id>         act as this API client (needed when auth.mode is required)",
    "  -d, --data <path>     data root",
  );
  if (op.rest.kind === "binary")
    lines.push("  --out <file|->        write the downloaded bytes here");
  return lines;
}

function listCommands(ops: AnyOperation[], out: (l: string) => void): void {
  const byArea = new Map<string, AnyOperation[]>();
  for (const o of ops) {
    const area = commandPath(o)[0]!;
    byArea.set(area, [...(byArea.get(area) ?? []), o]);
  }
  for (const [area, list] of byArea) {
    out(`${area}:`);
    for (const o of list) out(`  ${commandPath(o).join(" ").padEnd(34)}${o.title}`);
    if (area === "accounts")
      out(
        "  Account pooling by better-ccflare (MIT, © 2025 snipeship & tombii), a fork of ccflare by snipeship.",
      );
  }
}

/** `ops`, `<area>`, or `<area> <verb>...`. Returns a process exit code. */
export async function opsCommand(
  argv: string[],
  defaultRoot: () => string,
  deps: OpsDeps,
  ioOverride: Partial<OpsIo> = {},
): Promise<number> {
  const io: OpsIo = {
    out: ioOverride.out ?? console.log,
    err: ioOverride.err ?? console.error,
    write: ioOverride.write ?? ((b) => void process.stdout.write(b)),
    stdoutIsTty: ioOverride.stdoutIsTty,
  };
  // The CLI's own flags may stand before the command: `--client reader tasks list`.
  const lead: string[] = [];
  let at = 0;
  while (at < argv.length && argv[at]!.startsWith("-")) {
    const flag = argv[at]!;
    const takesValue =
      ["-d", "--data", "--client", "--out", "--input"].includes(flag) && at + 1 < argv.length;
    lead.push(...argv.slice(at, at + (takesValue ? 2 : 1)));
    at += takesValue ? 2 : 1;
  }
  argv = [...argv.slice(at), ...lead];
  const helpAsked = argv.includes("--help") || argv.includes("-h");

  if (argv[0] === "ops") {
    listCommands(cliOps(), io.out);
    io.out("");
    io.out("Each command takes --json (print JSON), --input <json|@file> and --help.");
    return 0;
  }
  const match = matchOpCommand(argv);
  if (!match) {
    const area = argv[0];
    if (area !== undefined && isOpArea(area)) {
      listCommands(
        cliOps().filter((o) => commandPath(o)[0] === area),
        io.out,
      );
      return helpAsked ? 0 : 1;
    }
    io.err(`unknown command "${argv.join(" ")}"`);
    return 1;
  }
  const { op, rest } = match;
  const path = commandPath(op).join(" ");

  // A bare Ctrl-C ends the command; tests hand in their own signal.
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  if (!deps.signal) process.once("SIGINT", onSigint);
  const signal = deps.signal ?? controller.signal;

  let json = false;
  try {
    const parsed = parseOpArgs(op, rest);
    json = parsed.json;
    if (parsed.help) {
      for (const l of helpFor(op)) io.out(l);
      return 0;
    }
    if (parsed.client !== undefined && !isKebabId(parsed.client)) {
      throw new CliUsageError("--client must be a kebab-case id");
    }
    if (op.rest.kind === "binary" && parsed.out === undefined) {
      throw new CliUsageError("pass --out <file> (or - for stdout)");
    }
    if (parsed.out === "-" && (io.stdoutIsTty ?? process.stdout.isTTY === true)) {
      throw new CliUsageError("binary output to a terminal: pass a file with --out or pipe it");
    }
    const root = dataRootOf(parsed.data, defaultRoot);
    const services = deps.services(root);
    const authStore = new AuthStore(root);
    // Identity first: a refused call must not create or migrate a data root. Reading settings
    // writes nothing; a v1 settings file is the one case that needs the migration first.
    const settings = await services.loadSettings().catch(async () => {
      await scaffoldDataRoot(root);
      return services.loadSettings();
    });
    let resolvePrincipal;
    try {
      resolvePrincipal = await localPrincipal({ settings, authStore, client: parsed.client });
    } catch (e) {
      if (e instanceof LocalPrincipalError) {
        io.err(`${path}: ${e.message}`);
        return 3;
      }
      throw e;
    }
    await scaffoldDataRoot(root);
    const input = { ...parsed.input };
    if (op.projectScoped && input.projectId === undefined) {
      if (!settings.defaultProject) throw new CliUsageError(NO_PROJECT);
      input.projectId = settings.defaultProject;
    }
    const ctx: OpContext = {
      root,
      principal: await resolvePrincipal(),
      services,
      authStore,
      now: () => new Date().toISOString(),
      signal,
    };
    // One audit line per operation run, the same log and settings as the web server's: who, what,
    // project, outcome, timing; never the arguments.
    const startedAt = Date.now();
    const audited = (ok: boolean, code?: string) => {
      // A rejected project id (a pasted key) is not a project. The root already exists:
      // scaffoldDataRoot ran above, and a refusal returns before that, so it creates nothing.
      const projectId = input.projectId;
      return auditOperation(root, {
        principal: ctx.principal,
        action: `cli:${op.name}`,
        via: "cli",
        project: typeof projectId === "string" && isKebabId(projectId) ? projectId : undefined,
        ok,
        code,
        ms: Date.now() - startedAt,
        at: startedAt,
      });
    };
    let result: unknown;
    try {
      result = (await op.execute(ctx, input)) as unknown;
    } catch (e) {
      await audited(false, toOpError(e).code);
      throw e;
    }
    await audited(true);
    if (signal.aborted) return 130;

    for (const w of warningsOf(result)) io.err(`warning (${w.code}): ${w.message}`);
    if (op.rest.kind === "binary") {
      const { bytes } = result as { bytes: Uint8Array };
      if (parsed.out === "-") io.write(bytes);
      else {
        const target = isAbsolute(parsed.out!) ? parsed.out! : resolve(process.cwd(), parsed.out!);
        await writeFile(target, bytes);
        io.out(`Wrote ${bytes.byteLength} bytes to ${target}`);
      }
      return 0;
    }
    if (json) {
      io.out(JSON.stringify(result, null, 2));
      return 0;
    }
    const human =
      (op.rest.text as ((r: unknown) => string) | undefined)?.(result) ??
      (op.summary as ((r: unknown) => string) | undefined)?.(result) ??
      JSON.stringify(result, null, 2);
    io.out(human);
    for (const field of ONE_TIME_SECRET_FIELDS) {
      const v = (result as Record<string, unknown> | null)?.[field];
      if (typeof v === "string") io.out(`${field}: ${v}`);
    }
    return 0;
  } catch (e) {
    if (signal.aborted) return 130;
    if (e instanceof CliUsageError) {
      io.err(`${path}: ${e.message}`);
      return 1;
    }
    const err = toOpError(e);
    if (json) io.err(JSON.stringify(err.toBody()));
    else {
      io.err(`${path}: ${err.code}: ${err.message}`);
      if (err.details !== undefined) io.err(`  ${JSON.stringify(err.details)}`);
    }
    return exitCodeFor(err);
  } finally {
    if (!deps.signal) process.removeListener("SIGINT", onSigint);
  }
}
