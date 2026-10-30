import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AuthStore, SettingsStore } from "@boof-runner/shared";
import { assertBindAllowed } from "@boof-runner/web";
import { scaffoldDataRoot } from "./scaffold.js";

export const SERVICE_HELP = `boof-runner service — run boof-runner as a systemd user service (Linux)

Usage:
  boof-runner service install [--data <dir>] [--port 4319] [--host 127.0.0.1] [--name boof-runner]
                              [--env KEY=VALUE]... [--env-file <path>] [--reset]
  boof-runner service uninstall [--name boof-runner]
  boof-runner service status [--name boof-runner]
  boof-runner service logs [--name boof-runner] [-f] [-n <lines>]

install    Writes ~/.config/systemd/user/<name>.service (node, the CLI and your current PATH are
           recorded as absolute paths, so nvm node and the claude, codex and opencode CLIs are found),
           then runs systemctl --user daemon-reload and enable --now. A running service is restarted.
           Refuses a --host the server itself would refuse (see: boof-runner remote setup).
           Run it again after an upgrade: every option you omit (--data, --port, --host, --env,
           --env-file and the recorded PATH) is reused from the installed unit and the command
           prints what it kept and what changed; --reset starts from the flags alone (it drops
           everything, the data root too: pass --data; single PATH entries or --env keys can only
           be removed this way). A unit from an older version is read once and its settings kept. node and
           the CLI path are always taken from the current install. The unit records the options
           (including --env values) in a comment line, so it is written with mode 0600.
           --env-file loads KEY=VALUE lines (for example ANTHROPIC_BASE_URL and
           ANTHROPIC_AUTH_TOKEN) from a private file (chmod 600) instead of writing
           secrets into the unit. Variables set only in your shell (e.g. fish universal
           variables) are not seen by systemd services.
uninstall  Disables and stops the service, removes the unit file and reloads systemd.
status     Shows systemctl --user status and the result of GET /healthz.
logs       Runs journalctl --user -u <name> (-f follows).

The service survives logout only when lingering is on: sudo loginctl enable-linger "$USER"`;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface HealthInfo {
  ok: boolean;
  summary: string;
}

/** Everything the service command takes from the outside world, replaceable in tests. */
export interface ServiceEnv {
  platform: NodeJS.Platform;
  home: string;
  user: string;
  /** PATH to record in the unit. */
  path: string;
  nodePath: string;
  /** Absolute path of bin/dist/boof-runner.js. */
  scriptPath: string;
  /** Run a command and capture its output (systemctl, loginctl). Never throws. */
  run: (cmd: string, args: string[]) => Promise<RunResult>;
  /** Run a command with its output on this terminal (journalctl); resolves with the exit code. */
  stream: (cmd: string, args: string[]) => Promise<number | null>;
  /** GET <base>/healthz. */
  health: (baseUrl: string) => Promise<HealthInfo>;
}

function runCapture(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => res({ code: null, stdout, stderr: stderr + String(e) }));
    child.on("close", (code) => res({ code, stdout, stderr }));
  });
}

function runStream(cmd: string, args: string[]): Promise<number | null> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", () => res(null));
    child.on("close", (code) => res(code));
  });
}

async function fetchHealth(baseUrl: string): Promise<HealthInfo> {
  try {
    const r = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { ok: false, summary: `HTTP ${r.status}` };
    const b = (await r.json()) as {
      version?: string;
      uptimeSeconds?: number;
      runner?: { enabled?: boolean; running?: boolean };
    };
    const runner = b.runner?.running
      ? "running"
      : b.runner?.enabled
        ? "enabled, not running"
        : "off";
    return {
      ok: true,
      summary: `ok (version ${b.version ?? "?"}, up ${b.uptimeSeconds ?? "?"}s, runner ${runner})`,
    };
  } catch (e) {
    return { ok: false, summary: `unreachable (${(e as Error).message})` };
  }
}

/** Path of the built CLI: bin/dist/boof-runner.js, from either the bundle or the TS source. */
function defaultScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return basename(here) === "dist"
    ? join(here, "boof-runner.js")
    : resolve(here, "..", "dist", "boof-runner.js");
}

export function defaultServiceEnv(): ServiceEnv {
  return {
    platform: process.platform,
    home: homedir(),
    user: process.env.USER ?? userInfo().username,
    path: process.env.PATH ?? "",
    nodePath: process.execPath,
    scriptPath: defaultScriptPath(),
    run: runCapture,
    stream: runStream,
    health: fetchHealth,
  };
}

/** One word of an ExecStart= line: `%` and `$` are special to systemd, whitespace needs quotes. */
export function execWord(word: string): string {
  const esc = word.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /^[A-Za-z0-9_\/.:@%+=,$-]+$/.test(esc)
    ? esc
    : `"${esc.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** An `Environment=` line; quoted only when the value needs it. `%` is doubled for systemd. */
export function envLine(key: string, value: string): string {
  const v = value.replace(/%/g, "%%");
  const assignment = `${key}=${v}`;
  return /[\s"'\\]/.test(assignment)
    ? `Environment="${assignment.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : `Environment=${assignment}`;
}

export const OPTIONS_MARKER = "# boof-runner-options: ";

/** The options the next install may reuse; recorded as a comment line in the unit. */
export interface InstallOptions {
  data: string;
  port: number;
  host: string;
  /** Extra KEY=VALUE pairs; they replace a PATH or HOME of the same name. */
  env: [string, string][];
  /** Absolute path of a KEY=VALUE file loaded by systemd (EnvironmentFile=); keeps secrets out of the unit. */
  envFile?: string;
  path: string;
}

export interface UnitOptions extends InstallOptions {
  name: string;
  nodePath: string;
  scriptPath: string;
  home: string;
}

export type SavedOptions =
  { kind: "none" } | { kind: "invalid"; reason: string } | { kind: "ok"; options: InstallOptions };

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Reads the options line of a unit: absent, present but unusable (with the reason), or valid. */
export function inspectInstallOptions(unitText: string): SavedOptions {
  const line = unitText.split("\n").find((l) => l.startsWith(OPTIONS_MARKER));
  if (line === undefined) return { kind: "none" };
  const bad = (reason: string): SavedOptions => ({ kind: "invalid", reason });
  let o: unknown;
  try {
    o = JSON.parse(line.slice(OPTIONS_MARKER.length));
  } catch {
    return bad("it is not valid JSON");
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return bad("it is not an object");
  const r = o as Record<string, unknown>;
  if (typeof r.data !== "string" || !isAbsolute(r.data))
    return bad("data must be an absolute path");
  if (typeof r.host !== "string" || !r.host) return bad("host must be a non-empty string");
  if (typeof r.path !== "string") return bad("path must be a string");
  if (typeof r.port !== "number" || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535)
    return bad("port must be an integer from 1 to 65535");
  if (r.envFile !== undefined && (typeof r.envFile !== "string" || !isAbsolute(r.envFile)))
    return bad("envFile must be an absolute path");
  if (!Array.isArray(r.env)) return bad("env must be a list");
  const env: [string, string][] = [];
  for (const e of r.env) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string" || typeof e[1] !== "string")
      return bad("env entries must be [key, value] pairs");
    if (!ENV_KEY_RE.test(e[0])) return bad(`env key "${e[0]}" is not a valid name`);
    if (CONTROL_RE.test(e[1])) return bad(`env ${e[0]} contains a control character`);
    env.push([e[0], e[1]]);
  }
  const strings = [r.data, r.host, r.path, ...(r.envFile ? [r.envFile as string] : [])];
  if (strings.some((x) => CONTROL_RE.test(x))) return bad("a value contains a control character");
  if (r.path.split(":").some((x) => x && !isAbsolute(x)))
    return bad("path entries must be absolute");
  return {
    kind: "ok",
    options: {
      data: r.data,
      port: r.port,
      host: r.host,
      env,
      ...(r.envFile !== undefined ? { envFile: r.envFile as string } : {}),
      path: r.path,
    },
  };
}

/** The options recorded in a unit by a previous install; undefined when absent or invalid. */
export function readInstallOptions(unitText: string): InstallOptions | undefined {
  const r = inspectInstallOptions(unitText);
  return r.kind === "ok" ? r.options : undefined;
}

/** Splits a systemd command line into words (double and single quotes, backslash, %% -> %). */
function splitExecWords(line: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length && q !== "'") {
      cur += line[++i];
      inWord = true;
    } else if (q) {
      if (c === q) q = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words.map((w) => w.replace(/%%/g, "%"));
}

/**
 * Settings of a unit written before the options line existed: -d/-p/--host from ExecStart=,
 * Environment= (PATH becomes `path`, HOME is dropped) and EnvironmentFile=. Undefined when the
 * unit does not look like one of ours.
 */
export function readLegacyUnitOptions(unitText: string): InstallOptions | undefined {
  const lines = unitText.split("\n");
  const exec = lines.find((l) => l.startsWith("ExecStart="));
  if (!exec) return undefined;
  const words = splitExecWords(exec.slice("ExecStart=".length));
  const after = (flag: string) => {
    const k = words.indexOf(flag);
    return k >= 0 ? words[k + 1] : undefined;
  };
  const data = after("-d");
  const port = Number(after("-p"));
  const host = after("--host");
  if (!data || !isAbsolute(data) || !host || !Number.isInteger(port) || port < 1 || port > 65535)
    return undefined;
  let path = "";
  const env: [string, string][] = [];
  for (const l of lines) {
    if (!l.startsWith("Environment=")) continue;
    for (const a of splitExecWords(l.slice("Environment=".length))) {
      const eq = a.indexOf("=");
      const key = eq > 0 ? a.slice(0, eq) : "";
      if (!ENV_KEY_RE.test(key)) continue;
      const val = a.slice(eq + 1);
      if (key === "PATH") path = val;
      else if (key !== "HOME") env.push([key, val]);
    }
  }
  const envFile = lines
    .find((l) => l.startsWith("EnvironmentFile="))
    ?.slice("EnvironmentFile=".length);
  return { data, port, host, env, ...(envFile ? { envFile } : {}), path };
}

/** This shell's PATH entries followed by the previous ones not already present. */
export function mergePath(current: string, previous: string | undefined): string {
  const all = [...current.split(":"), ...(previous?.split(":") ?? [])].filter(Boolean);
  return [...new Set(all)].join(":");
}

/** flag > previous install > default; --env merged per key; the report never shows env values. */
export function mergeInstallOptions(
  args: {
    data?: string;
    port?: number;
    host?: string;
    env: [string, string][];
    envFile?: string;
    path: string;
  },
  previous: InstallOptions | undefined,
  defaults: { data: () => string; port: number },
): { options: InstallOptions; report: string[] } {
  const report: string[] = [];
  const scalar = <T extends string | number>(
    label: string,
    flag: T | undefined,
    prev: T | undefined,
    dflt: () => T,
  ): T => {
    if (flag !== undefined) {
      report.push(
        prev === undefined
          ? `${label}: ${flag}`
          : prev === flag
            ? `${label}: ${flag} (kept)`
            : `${label}: ${prev} -> ${flag}`,
      );
      return flag;
    }
    if (prev !== undefined) {
      report.push(`${label}: ${prev} (kept)`);
      return prev;
    }
    const d = dflt();
    report.push(`${label}: ${d}`);
    return d;
  };
  const data = scalar("data", args.data, previous?.data, defaults.data);
  const port = scalar("port", args.port, previous?.port, () => defaults.port);
  const host = scalar("host", args.host, previous?.host, () => "127.0.0.1");

  const envFile = args.envFile ?? previous?.envFile;
  report.push(
    envFile === undefined
      ? "env-file: none"
      : args.envFile === undefined || args.envFile === previous?.envFile
        ? `env-file: ${envFile} (kept)`
        : `env-file: ${envFile}`,
  );

  const merged = new Map<string, string>(previous?.env ?? []);
  const tags = new Map<string, string>([...merged.keys()].map((k) => [k, "kept"]));
  for (const [k, val] of args.env) {
    tags.set(k, !merged.has(k) ? "new" : merged.get(k) === val ? "kept" : "changed");
    merged.set(k, val);
  }
  report.push(
    tags.size === 0 ? "env: none" : `env: ${[...tags].map(([k, t]) => `${k} (${t})`).join(", ")}`,
  );

  const path = mergePath(args.path, previous?.path);
  if (!previous) report.push("PATH: from this shell");
  else {
    const prevEntries = new Set(previous.path.split(":"));
    const added = new Set(args.path.split(":").filter((e) => e && !prevEntries.has(e))).size;
    report.push(
      added === 0
        ? "PATH: kept"
        : `PATH: kept, ${added} ${added === 1 ? "directory" : "directories"} added from this shell`,
    );
  }

  return {
    options: {
      data,
      port,
      host,
      env: [...merged],
      ...(envFile !== undefined ? { envFile } : {}),
      path,
    },
    report,
  };
}

/** Contents of the systemd user unit. */
export function buildUnit(o: UnitOptions): string {
  const env = new Map<string, string>([
    ["PATH", o.path],
    ["HOME", o.home],
  ]);
  for (const [k, v] of o.env) env.set(k, v);
  const exec = [
    o.nodePath,
    o.scriptPath,
    "serve",
    "-d",
    o.data,
    "-p",
    String(o.port),
    "--host",
    o.host,
  ]
    .map(execWord)
    .join(" ");
  const recorded = {
    data: o.data,
    port: o.port,
    host: o.host,
    env: o.env,
    envFile: o.envFile,
    path: o.path,
  };
  return (
    [
      `${OPTIONS_MARKER}${JSON.stringify(recorded)}`,
      "# Options you omit on the next `boof-runner service install` are reused from this line (--reset starts over).",
      "[Unit]",
      `Description=Boof Runner (${o.name})`,
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${exec}`,
      `WorkingDirectory=${o.data}`,
      "Restart=on-failure",
      "RestartSec=5",
      "TimeoutStopSec=60",
      ...[...env].map(([k, v]) => envLine(k, v)),
      ...(o.envFile ? [`EnvironmentFile=${o.envFile}`] : []),
      "NoNewPrivileges=yes",
      "UMask=0077",
      "",
      "[Install]",
      "WantedBy=default.target",
    ].join("\n") + "\n"
  );
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.@-]*$/;

function unitName(name: string): string {
  return `${name}.service`;
}

function unitPath(env: ServiceEnv, name: string): string {
  return join(env.home, ".config", "systemd", "user", unitName(name));
}

function manualHelp(): string {
  return (
    "Manual alternatives: run it under tmux/screen (boof-runner serve -d <data>), use a process " +
    "manager such as pm2 (pm2 start bin/dist/boof-runner.js -- serve -d <data>), or write your own " +
    "init script. `boof-runner service` only supports Linux with systemd --user."
  );
}

async function requireSystemd(env: ServiceEnv, err: (l: string) => void): Promise<boolean> {
  if (env.platform !== "linux") {
    err(
      `service: only Linux with systemd is supported (this is ${env.platform}).\n${manualHelp()}`,
    );
    return false;
  }
  const r = await env.run("systemctl", ["--user", "show-environment"]);
  if (r.code !== 0) {
    err(
      "service: cannot reach the systemd user manager (systemctl --user failed" +
        `${r.stderr.trim() ? `: ${r.stderr.trim().split("\n")[0]}` : ""}).\n` +
        "On a server, log in over ssh (not su/sudo) or run: export XDG_RUNTIME_DIR=/run/user/$(id -u)\n" +
        "Lingering must be on for a user manager without a login: sudo loginctl enable-linger $USER\n" +
        manualHelp(),
    );
    return false;
  }
  return true;
}

function baseUrl(host: string, port: number): string {
  const shown = host === "0.0.0.0" || host === "::" || host === "[::]" ? "127.0.0.1" : host;
  return `http://${shown.includes(":") && !shown.startsWith("[") ? `[${shown}]` : shown}:${port}`;
}

/** `service` subcommand. Returns a process exit code. */
export async function serviceCommand(
  argv: string[],
  defaultRoot: () => string,
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
  env: ServiceEnv = defaultServiceEnv(),
): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    out(SERVICE_HELP);
    return sub ? 0 : 1;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      options: {
        data: { type: "string", short: "d" },
        port: { type: "string", short: "p" },
        host: { type: "string" },
        name: { type: "string" },
        env: { type: "string", multiple: true },
        "env-file": { type: "string" },
        reset: { type: "boolean" },
        follow: { type: "boolean", short: "f" },
        lines: { type: "string", short: "n" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    err(`service: ${(e as Error).message}\n`);
    err(SERVICE_HELP);
    return 1;
  }
  const v = parsed.values;
  if (v.help) {
    out(SERVICE_HELP);
    return 0;
  }
  const name = (v.name as string | undefined) ?? "boof-runner";
  if (!NAME_RE.test(name)) {
    err(`service: invalid --name "${name}" (letters, digits, _ . @ -)`);
    return 1;
  }
  try {
    switch (sub) {
      case "install":
        return await install(v, name, defaultRoot, out, err, env);
      case "uninstall":
        return await uninstall(name, out, err, env);
      case "status":
        return await status(name, out, err, env);
      case "logs":
        return await logs(v, name, err, env);
      default:
        err(`service: unknown subcommand "${sub}"\n`);
        err(SERVICE_HELP);
        return 1;
    }
  } catch (e) {
    err(`service ${sub}: ${(e as Error).message}`);
    return 1;
  }
}

type Values = ReturnType<typeof parseArgs>["values"];

async function install(
  v: Values,
  name: string,
  defaultRoot: () => string,
  out: (l: string) => void,
  err: (l: string) => void,
  env: ServiceEnv,
): Promise<number> {
  for (const flag of ["data", "env-file", "host", "port"] as const) {
    const val = v[flag];
    if (typeof val === "string" && val.trim() === "") {
      err(
        `service install: --${flag} is empty (an unset shell variable?); give a value, or omit it to keep the existing unit's setting`,
      );
      return 1;
    }
  }
  const portFlag = v.port as string | undefined;
  const portArg = portFlag === undefined ? undefined : Number(portFlag);
  if (portArg !== undefined && (!Number.isInteger(portArg) || portArg < 1 || portArg > 65535)) {
    err("service install: --port must be 1-65535");
    return 1;
  }
  const extra: [string, string][] = [];
  for (const kv of (v.env as string[] | undefined) ?? []) {
    const eq = kv.indexOf("=");
    const key = eq > 0 ? kv.slice(0, eq) : "";
    if (!ENV_KEY_RE.test(key)) {
      err(
        `service install: --env expects KEY=VALUE, got "${eq > 0 ? key : "(no name)"}" before "="`,
      );
      return 1;
    }
    if (key === "PATH" || key === "HOME") {
      err(
        `service install: --env ${key} is not allowed (${key === "PATH" ? "PATH is merged from this shell and the previous install" : "the unit sets HOME itself"})`,
      );
      return 1;
    }
    if (CONTROL_RE.test(kv.slice(eq + 1))) {
      err(`service install: --env ${key} contains a control character (newline, tab, ...)`);
      return 1;
    }
    extra.push([key, kv.slice(eq + 1)]);
  }
  for (const [flag, val] of [
    ["--data", v.data],
    ["--env-file", v["env-file"]],
  ] as const) {
    if (typeof val === "string" && CONTROL_RE.test(val)) {
      err(`service install: ${flag} contains a control character (newline, tab, ...)`);
      return 1;
    }
  }
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));
  const envFileOpt = v["env-file"] as string | undefined;
  const dataOpt = v.data as string | undefined;
  const file = unitPath(env, name);
  let previousText: string | undefined;
  try {
    previousText = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  let previous: InstallOptions | undefined;
  let legacy = false;
  if (!v.reset && previousText !== undefined) {
    const saved = inspectInstallOptions(previousText);
    if (saved.kind === "invalid") {
      err(
        `service install: the options line in ${file} is unusable (${saved.reason}); fix or delete that line, or pass --reset (with --data) to start from the flags`,
      );
      return 1;
    }
    if (saved.kind === "ok") previous = saved.options;
    else {
      previous = readLegacyUnitOptions(previousText);
      legacy = previous !== undefined;
    }
  }
  // BOOF_RUNNER_PORT only matters when neither a flag nor the previous install supplies the port.
  let defaultPort = 4319;
  if (portArg === undefined && !previous) {
    defaultPort = Number(process.env.BOOF_RUNNER_PORT ?? 4319);
    if (!Number.isInteger(defaultPort) || defaultPort < 1 || defaultPort > 65535) {
      err("service install: BOOF_RUNNER_PORT must be 1-65535");
      return 1;
    }
  }
  const { options, report } = mergeInstallOptions(
    {
      data: dataOpt === undefined ? undefined : abs(dataOpt),
      port: portArg,
      host: v.host as string | undefined,
      env: extra,
      envFile: envFileOpt === undefined ? undefined : abs(envFileOpt),
      path: env.path,
    },
    previous,
    { data: defaultRoot, port: defaultPort },
  );
  out(
    v.reset
      ? "Ignoring the previous install's options (--reset)"
      : legacy
        ? `Reusing the settings of the existing unit ${file} (installed by an older version, no options line)`
        : previous
          ? `Reusing options recorded in ${file}`
          : previousText !== undefined
            ? "Previous unit has no recorded options; installing from the flags"
            : "No previous install found; installing from the flags",
  );
  for (const l of report)
    out(
      `  ${
        legacy
          ? l
              .replace(/\(kept\)/g, "(kept from the existing unit)")
              .replace(/^PATH: kept/, "PATH: kept from the existing unit")
          : l
      }`,
    );
  const { data, port, host, envFile } = options;
  if (envFile !== undefined) {
    let mode: number;
    try {
      mode = (await stat(envFile)).mode;
    } catch {
      err(`service install: --env-file ${envFile} does not exist`);
      return 1;
    }
    if (mode & 0o077) {
      err(
        `service install: --env-file ${envFile} is readable by other users; run: chmod 600 "${envFile}"`,
      );
      return 1;
    }
  }

  if (!(await requireSystemd(env, err))) return 1;
  if (!existsSync(env.scriptPath)) {
    err(
      `service install: ${env.scriptPath} does not exist; build first (npm run build -w @boof-runner/cli)`,
    );
    return 1;
  }

  // Refuse what the server would refuse at start-up, instead of installing a unit that crash-loops.
  await scaffoldDataRoot(data);
  try {
    await assertBindAllowed(host, await new SettingsStore(data).load(), new AuthStore(data));
  } catch (e) {
    err(
      `service install: ${(e as Error).message}\n` +
        "Keep --host 127.0.0.1 behind a reverse proxy, or prepare remote access first: " +
        "boof-runner remote setup --hostname <public-host> -d " +
        data,
    );
    return 1;
  }

  const unit = buildUnit({
    name,
    data,
    port,
    host,
    nodePath: env.nodePath,
    scriptPath: env.scriptPath,
    path: options.path,
    home: env.home,
    env: options.env,
    envFile,
  });
  const wasActive =
    (await env.run("systemctl", ["--user", "is-active", "--quiet", unitName(name)])).code === 0;
  await mkdir(dirname(file), { recursive: true });
  // The unit records --env values in its options comment, so keep it private to the owner.
  // Written to a private temp file next to it and renamed over: no window with wider permissions.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, unit, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  out(`Wrote ${file}`);

  const steps: [string, string[]][] = [
    ["systemctl", ["--user", "daemon-reload"]],
    ["systemctl", ["--user", "enable", "--now", unitName(name)]],
  ];
  if (wasActive) steps.push(["systemctl", ["--user", "restart", unitName(name)]]);
  for (const [cmd, args] of steps) {
    const r = await env.run(cmd, args);
    if (r.code !== 0) {
      err(
        `service install: \`${cmd} ${args.join(" ")}\` failed: ${r.stderr.trim() || `exit ${r.code}`}`,
      );
      return 1;
    }
  }

  const st = await env.run("systemctl", [
    "--user",
    "status",
    unitName(name),
    "--no-pager",
    "--lines=5",
  ]);
  out(st.stdout.trimEnd());
  out("");
  out(`Boof Runner is running as ${unitName(name)} at ${baseUrl(host, port)}`);
  out(`Data root: ${data}`);

  const linger = await env.run("loginctl", ["show-user", env.user, "-p", "Linger"]);
  if (!/^Linger=yes$/m.test(linger.stdout)) {
    out("");
    out(
      "warning: lingering is off, so the service stops when you log out and does not start at boot.\n" +
        `Enable it with: sudo loginctl enable-linger ${env.user}`,
    );
  }
  return 0;
}

async function uninstall(
  name: string,
  out: (l: string) => void,
  err: (l: string) => void,
  env: ServiceEnv,
): Promise<number> {
  if (!(await requireSystemd(env, err))) return 1;
  const file = unitPath(env, name);
  if (!existsSync(file)) out(`No unit file at ${file}; cleaning up anyway.`);
  await env.run("systemctl", ["--user", "disable", "--now", unitName(name)]);
  await rm(file, { force: true });
  const r = await env.run("systemctl", ["--user", "daemon-reload"]);
  if (r.code !== 0) {
    err(`service uninstall: daemon-reload failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    return 1;
  }
  await env.run("systemctl", ["--user", "reset-failed", unitName(name)]);
  out(`Removed ${unitName(name)}. Data was not touched.`);
  return 0;
}

/** Port and host the installed unit serves on, read from its ExecStart line. */
async function unitEndpoint(
  env: ServiceEnv,
  name: string,
): Promise<{ host: string; port: number }> {
  let text = "";
  try {
    text = await readFile(unitPath(env, name), "utf8");
  } catch {
    /* not installed: defaults */
  }
  const exec = text.split("\n").find((l) => l.startsWith("ExecStart=")) ?? "";
  const port = Number(/ -p (\d+)/.exec(exec)?.[1] ?? 4319);
  const host = /--host (\S+)/.exec(exec)?.[1] ?? "127.0.0.1";
  return { host: host.replace(/^"|"$/g, ""), port };
}

async function status(
  name: string,
  out: (l: string) => void,
  err: (l: string) => void,
  env: ServiceEnv,
): Promise<number> {
  if (!(await requireSystemd(env, err))) return 1;
  const st = await env.run("systemctl", [
    "--user",
    "status",
    unitName(name),
    "--no-pager",
    "--lines=10",
  ]);
  out((st.stdout || st.stderr).trimEnd());
  const { host, port } = await unitEndpoint(env, name);
  const h = await env.health(baseUrl(host, port));
  out("");
  out(`healthz: ${h.summary}`);
  return st.code === 0 && h.ok ? 0 : 1;
}

async function logs(
  v: Values,
  name: string,
  err: (l: string) => void,
  env: ServiceEnv,
): Promise<number> {
  if (!(await requireSystemd(env, err))) return 1;
  const lines = (v.lines as string | undefined) ?? "100";
  if (!/^\d+$/.test(lines)) {
    err("service logs: -n expects a number");
    return 1;
  }
  const args = ["--user", "-u", unitName(name), "-n", lines];
  if (v.follow) args.push("-f");
  else args.push("--no-pager");
  return (await env.stream("journalctl", args)) ?? 1;
}
