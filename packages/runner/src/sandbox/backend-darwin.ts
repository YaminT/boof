import { existsSync } from "node:fs";
import {
  SandboxUnavailableError,
  type CommandLaunch,
  type SandboxChild,
  type SandboxLaunchPolicy,
  type SandboxSpawnPlan,
} from "@boof/heart";

/**
 * macOS backend. Generates a Seatbelt profile from the same policy the Linux helper consumes
 * and runs `/usr/bin/sandbox-exec -p <profile>`. There is no Landlock ABI here: a missing
 * `sandbox-exec` or a profile the kernel will not apply fails the self-test, and no agent starts.
 *
 * Decisions, where the design leaves a choice:
 * - Seatbelt is last-match-wins for filtered rules. The `*:*` allows come first and the
 *   per-port denies come after, so they win. `sandbox-exec` only accepts `localhost` or `*`
 *   as an IP host, so the design's `localhost:<port>` form is the one that both compiles and
 *   covers 127.0.0.1 and ::1. A literal `127.0.0.1` makes the whole profile fail to compile.
 * - Section 4's macOS sentence names the outbound rules. Bind is denied for the same ports
 *   because the platform-neutral rule denies bind and row A4 requires it. Inbound on those
 *   ports is denied for the same reason.
 * - `socket(AF_UNIX)` is allowed so `socketpair` keeps working (Node and shells use it for
 *   child pipes, as seccomp does on Linux). There is no unix-socket path rule, so connect
 *   and bind to a pathname socket stay denied.
 * - `file-map-executable` is global. dyld maps the shared cache through that check, and
 *   mapping does not grant file bytes. Directory metadata is global so a lookup can walk
 *   ancestors; listing a directory and reading a file still need a granted subpath.
 *   The root inode is the exception: dyld reads `/` itself while resolving the first
 *   component, and a literal read of `/` does not reveal anything under it.
 * - `/tmp`, `/var` and `/etc` are symlinks to `/private/tmp`, `/private/var` and
 *   `/private/etc`. Seatbelt matches the path the syscall presents, so a grant of one
 *   spelling misses the other. Each granted path is emitted under both spellings. The
 *   alias keeps the same suffix (`/private/var/folders/x` and `/var/folders/x`), so it
 *   is the same directory and not a wider root.
 * - `process-exec*` covers the binary and a shebang interpreter. It does not replace
 *   the file-read check: a binary outside a granted path is still unreadable, so it
 *   cannot be executed. `dynamic-code-generation` is V8's MAP_JIT. Without it the
 *   Node canary is killed and `enforce` never starts.
 * - Mach lookup is a fixed list a CLI needs to start. The Security Server and `securityd`
 *   are not on it: that is the Keychain, and opening it opens all of it.
 * - `sysctl-read` is unfiltered. A short name list misses `hw.*` names current macOS shells
 *   read at startup. `sysctl-write` stays denied except `kern.tcsm_enable`, which V8 writes
 *   once while starting.
 * - A path with a quote, backslash, newline, carriage return, NUL or other control character
 *   is refused before spawn. Those characters would break out of a profile string or encode
 *   an escape. An apostrophe is included: the profile quotes with `"`.
 */

export const DARWIN_SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Parent-side override for tests. The child does not need it. Analogous to `BOOF_SANDBOX_HELPER`. */
export function darwinSandboxExecPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BOOF_SANDBOX_EXEC;
  if (override && override.length > 0) return override;
  return DARWIN_SANDBOX_EXEC;
}

/** Services libsystem, dyld and a CLI need. Not the Keychain. */
const MACH_LOOKUP = [
  "com.apple.audio.systemsoundserver",
  "com.apple.bsd.dirhelper",
  "com.apple.cfprefsd.agent",
  "com.apple.cfprefsd.daemon",
  "com.apple.CoreServices.coreservicesd",
  "com.apple.coreservices.launchservicesd",
  "com.apple.distributed_notifications.2",
  "com.apple.distributed_notifications@Uv3",
  "com.apple.FontObjectsServer",
  "com.apple.fonts",
  "com.apple.logd",
  "com.apple.lsd.mapdb",
  "com.apple.PowerManagement.control",
  "com.apple.system.logger",
  "com.apple.system.notification_center",
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.opendirectoryd.membership",
] as const;

const POLICY_KEYS = ["version", "readExec", "readWrite", "denyTcpPorts", "env"] as const;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNSAFE = /["'\n\r\\\0]|[\u0001-\u001f\u007f]/;

function corrupt(): SandboxUnavailableError {
  return new SandboxUnavailableError("sandbox policy is corrupt");
}

function unsafePath(): SandboxUnavailableError {
  return new SandboxUnavailableError("sandbox policy path contains a quote or newline");
}

function pathKind(value: unknown): "ok" | "unsafe" | "bad" {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return "bad";
  if (UNSAFE.test(value)) return "unsafe";
  if (!value.startsWith("/")) return "bad";
  if (value.split("/").some((part) => part === "." || part === "..")) return "bad";
  return "ok";
}

function pathList(value: unknown): string[] {
  if (!Array.isArray(value)) throw corrupt();
  const out: string[] = [];
  for (const item of value) {
    const kind = pathKind(item);
    if (kind === "unsafe") throw unsafePath();
    if (kind !== "ok") throw corrupt();
    out.push(item as string);
  }
  return out;
}

function checkedPolicy(policy: unknown): SandboxLaunchPolicy {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) throw corrupt();
  const record = policy as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== POLICY_KEYS.length || POLICY_KEYS.some((key) => !keys.includes(key))) {
    throw corrupt();
  }
  if (record.version !== 1) throw corrupt();
  const readExec = pathList(record.readExec);
  const readWrite = pathList(record.readWrite);
  if (
    !Array.isArray(record.denyTcpPorts) ||
    !record.denyTcpPorts.every(
      (port) => typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535,
    )
  ) {
    throw corrupt();
  }
  const env = record.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) throw corrupt();
  const envOk = Object.entries(env as Record<string, unknown>).every(
    ([key, value]) => ENV_NAME.test(key) && typeof value === "string" && !value.includes("\0"),
  );
  if (!envOk) throw corrupt();
  return {
    version: 1,
    readExec,
    readWrite,
    denyTcpPorts: record.denyTcpPorts as number[],
    env: env as Record<string, string>,
  };
}

/** A profile string. The value has already been rejected if it could break the quotes. */
function sbplQuote(value: string): string {
  return `"${value}"`;
}

/** Symlink roots Seatbelt does not collapse. The two spellings are one directory. */
const SYMLINK_ROOTS: ReadonlyArray<readonly [string, string]> = [
  ["/private/var", "/var"],
  ["/private/tmp", "/tmp"],
  ["/private/etc", "/etc"],
];

function aliasPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return null;
}

/** The path as granted, plus the other spelling when it sits under a symlink root. */
function seatbeltPathSpellings(path: string): string[] {
  const out = [path];
  for (const [canonical, link] of SYMLINK_ROOTS) {
    const alias = aliasPath(path, canonical, link) ?? aliasPath(path, link, canonical);
    if (alias && !out.includes(alias)) out.push(alias);
  }
  return out;
}

function subpaths(paths: readonly string[]): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    for (const spelling of seatbeltPathSpellings(path)) {
      if (seen.has(spelling)) continue;
      seen.add(spelling);
      lines.push(`  (subpath ${sbplQuote(spelling)})`);
    }
  }
  return lines;
}

/**
 * Profile text for one policy. Throws before any process starts when the policy is corrupt
 * or a path cannot be quoted. Does not look for `sandbox-exec`.
 */
export function renderSeatbeltProfile(policy: SandboxLaunchPolicy): string {
  const checked = checkedPolicy(policy);
  const lines = [
    "(version 1)",
    "(deny default)",
    // `process-exec*` covers interpreter execution on some Seatbelt versions, but the
    // base operation is needed for ordinary execve/execvp on current macOS runners.
    "(allow process-exec)",
    "(allow process-exec*)",
    "(allow process-fork)",
    "(allow process-info* (target same-sandbox))",
    "(allow signal (target same-sandbox))",
    "(allow mach-priv-task-port (target same-sandbox))",
    "(allow file-map-executable)",
    "(allow dynamic-code-generation)",
    "(allow sysctl-read)",
    '(allow sysctl-write (sysctl-name "kern.tcsm_enable"))',
    "(allow user-preference-read)",
    "(allow distributed-notification-post)",
    "(allow mach-lookup",
    ...MACH_LOOKUP.map((name) => `  (global-name ${sbplQuote(name)})`),
    ")",
    "(allow iokit-open",
    '  (iokit-registry-entry-class "IOSurfaceRootUserClient")',
    '  (iokit-registry-entry-class "RootDomainUserClient")',
    '  (iokit-user-client-class "IOSurfaceSendRight")',
    ")",
    "(allow iokit-get-properties)",
    "(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))",
    "(allow system-socket (socket-domain AF_INET))",
    "(allow system-socket (socket-domain AF_INET6))",
    "(allow system-socket (socket-domain AF_UNIX))",
    "(allow file-read-metadata (vnode-type DIRECTORY))",
    '(allow file-read-data (literal "/"))',
    '(allow file-ioctl (literal "/dev/dtracehelper"))',
  ];
  if (checked.readExec.length > 0) {
    lines.push("(allow file-read* file-map-executable", ...subpaths(checked.readExec), ")");
  }
  if (checked.readWrite.length > 0) {
    lines.push(
      "(allow file-read* file-write* file-map-executable",
      ...subpaths(checked.readWrite),
      ")",
    );
    const devices = checked.readWrite.filter((path) => path === "/dev" || path.startsWith("/dev/"));
    if (devices.length > 0) {
      lines.push(
        "(allow file-ioctl",
        ...devices.map((path) => `  (literal ${sbplQuote(path)})`),
        ")",
      );
    }
  }
  lines.push(
    '(allow network-outbound (remote ip "*:*"))',
    '(allow network-bind (local ip "*:*"))',
    '(allow network-inbound (local ip "*:*"))',
  );
  const ports: number[] = [];
  for (const port of checked.denyTcpPorts) {
    if (!ports.includes(port)) ports.push(port);
  }
  for (const port of ports) {
    lines.push(
      `(deny network-outbound (remote ip "localhost:${port}"))`,
      `(deny network-bind (local ip "localhost:${port}"))`,
      `(deny network-inbound (local ip "localhost:${port}"))`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Turn a sandbox launch into `sandbox-exec -p <profile> <command>`. Does not spawn.
 * The fourth stdio pipe is unused: the launcher always opens one for the Linux policy,
 * and `deliver` closes it.
 */
export function planDarwinSandbox(
  launch: Extract<CommandLaunch, { kind: "sandbox" }>,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
): SandboxSpawnPlan {
  const profile = renderSeatbeltProfile(launch.policy);
  const bin = darwinSandboxExecPath();
  if (!existsSync(bin)) throw new SandboxUnavailableError("sandbox-exec is missing");
  const childEnv: NodeJS.ProcessEnv = { ...(env ?? process.env), ...launch.policy.env };
  const spawnArgs = ["-p", profile, command, ...args];
  if (process.env.BOOF_DEBUG_SEATBELT_PROFILE === "1" && !seatbeltTraceUsed) {
    seatbeltTraceUsed = true;
    spawnArgs.unshift("-t", `${process.env.RUNNER_TEMP ?? "/tmp"}/seatbelt.trace`);
  }
  return {
    command: bin,
    args: spawnArgs,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    deliver(child: SandboxChild) {
      const pipe = child.stdio?.[3] as { end?: () => void } | null | undefined;
      try {
        pipe?.end?.();
      } catch {
        /* The profile is already in argv. This pipe is the Linux policy fd. */
      }
    },
  };
}

let seatbeltTraceUsed = false;
