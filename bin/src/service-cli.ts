import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
                              [--env KEY=VALUE]... [--env-file <path>]
  boof-runner service uninstall [--name boof-runner]
  boof-runner service status [--name boof-runner]
  boof-runner service logs [--name boof-runner] [-f] [-n <lines>]

install    Writes ~/.config/systemd/user/<name>.service (node, the CLI and your current PATH are
           recorded as absolute paths, so nvm node and the claude, codex and opencode CLIs are found),
           then runs systemctl --user daemon-reload and enable --now. A running service is restarted.
           Refuses a --host the server itself would refuse (see: boof-runner remote setup).
           Run it again after an upgrade or to change options.
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

export interface UnitOptions {
  name: string;
  data: string;
  port: number;
  host: string;
  nodePath: string;
  scriptPath: string;
  path: string;
  home: string;
  /** Extra KEY=VALUE pairs; they replace a PATH or HOME of the same name. */
  env: [string, string][];
  /** Absolute path of a KEY=VALUE file loaded by systemd (EnvironmentFile=); keeps secrets out of the unit. */
  envFile?: string;
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
  return (
    [
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
  const port = Number((v.port as string | undefined) ?? process.env.BOOF_RUNNER_PORT ?? 4319);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    err("service install: --port must be 1-65535");
    return 1;
  }
  const host = (v.host as string | undefined) ?? "127.0.0.1";
  const extra: [string, string][] = [];
  for (const kv of (v.env as string[] | undefined) ?? []) {
    const eq = kv.indexOf("=");
    const key = eq > 0 ? kv.slice(0, eq) : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      err(`service install: --env expects KEY=VALUE, got "${kv}"`);
      return 1;
    }
    extra.push([key, kv.slice(eq + 1)]);
  }
  const envFileOpt = v["env-file"] as string | undefined;
  let envFile: string | undefined;
  if (envFileOpt !== undefined) {
    envFile = isAbsolute(envFileOpt) ? envFileOpt : resolve(process.cwd(), envFileOpt);
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
  const dataOpt = v.data as string | undefined;
  const data = dataOpt
    ? isAbsolute(dataOpt)
      ? dataOpt
      : resolve(process.cwd(), dataOpt)
    : defaultRoot();

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
    path: env.path,
    home: env.home,
    env: extra,
    envFile,
  });
  const file = unitPath(env, name);
  const wasActive =
    (await env.run("systemctl", ["--user", "is-active", "--quiet", unitName(name)])).code === 0;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, unit, "utf8");
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
