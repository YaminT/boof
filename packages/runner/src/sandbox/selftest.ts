import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { execCommand, SandboxUnavailableError, type SandboxLaunchPolicy } from "@boof/heart";
import {
  DARWIN_SYSTEM_ROOTS,
  LINUX_LIB_PATHS,
  LINUX_SYSTEM_ROOTS,
  SANDBOX_DEVICES,
} from "./policy.js";

/** Fixed order. `signal` is judged only when the Landlock ABI is 6 or newer. */
export const SELF_TEST_PROBES = [
  "data-root-read",
  "denied-port",
  "unix-socket",
  "write-outside",
  "signal",
  "write-inside",
] as const;

export type SelfTestProbe = (typeof SELF_TEST_PROBES)[number];

export interface SelfTestProbeResult {
  id: string;
  outcome: string;
}

const DENY_REASON: Record<string, string> = {
  "data-root-read": "self-test: read a file inside the data root",
  "denied-port": "self-test: connected to a denied TCP port",
  "unix-socket": "self-test: connected to a pathname unix socket",
  "write-outside": "self-test: wrote outside the allowed folder",
  signal: "self-test: signalled the server",
};

const WRITE_INSIDE_REASON = "self-test: could not write inside the allowed folder";
export const SIGNALS_NOT_SCOPED = "signals not scoped (kernel older than 6.12)";

/**
 * Pure verdict. A probe is denied only when its outcome is exactly `denied` (EACCES or EPERM).
 * Any other outcome, including a missing line, fails that probe. ABI below 6 does not judge
 * the signal probe: those kernels cannot scope signals, and a pass still says so.
 */
export function judgeSelfTest(
  results: readonly SelfTestProbeResult[],
  abi: number,
): { ok: true; reason: string } | { ok: false; reason: string } {
  const byId = new Map(results.map((result) => [result.id, result.outcome]));
  const mustDeny = ["data-root-read", "denied-port", "unix-socket", "write-outside"];
  if (abi >= 6) mustDeny.push("signal");
  for (const id of mustDeny) {
    if (byId.get(id) !== "denied") return { ok: false, reason: DENY_REASON[id]! };
  }
  if (byId.get("write-inside") !== "allowed") return { ok: false, reason: WRITE_INSIDE_REASON };
  if (abi >= 4 && abi < 6) return { ok: true, reason: SIGNALS_NOT_SCOPED };
  return { ok: true, reason: "" };
}

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ReturnType<typeof spawn>;

/** `BOOF_SANDBOX_FAKE_ABI` is test-only. It is read before any helper spawn. */
export function readFakeAbi(
  env: NodeJS.ProcessEnv,
): { kind: "unset" } | { kind: "bad" } | { kind: "n"; n: number } {
  if (!Object.prototype.hasOwnProperty.call(env, "BOOF_SANDBOX_FAKE_ABI")) return { kind: "unset" };
  const raw = env.BOOF_SANDBOX_FAKE_ABI ?? "";
  if (!/^\d{1,3}$/.test(raw)) return { kind: "bad" };
  return { kind: "n", n: Number(raw) };
}

export function readHelperAbi(helper: string, spawnFn: SpawnFn = spawn): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      reject(new SandboxUnavailableError(reason));
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(helper, ["--abi"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      return;
    }
    let out = "";
    let errText = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      fail("boof-sandbox --abi timed out");
    }, 5000);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      out += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      errText += String(chunk);
    });
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      fail(err.message);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      const text = out.trim();
      if (code === 0 && /^\d{1,3}$/.test(text)) {
        if (settled) return;
        settled = true;
        resolve(Number(text));
        return;
      }
      const reason =
        errText.replace(/boof-sandbox:\s*/g, "").trim() ||
        `boof-sandbox --abi exited ${code ?? "null"}`;
      fail(reason);
    });
  });
}

const CANARY = `
const fs = require("fs");
const net = require("net");
const [dataFile, outsideFile, insideFile, port, sock, pid] = process.argv.slice(1);
const out = {};
function kind(err) {
  if (!err) return "allowed";
  const code = err.code || "";
  if (code === "EACCES" || code === "EPERM") return "denied";
  return "error:" + (code || "UNKNOWN");
}
function finish() {
  for (const name of ["data-root-read","denied-port","unix-socket","write-outside","signal","write-inside"]) {
    process.stdout.write(name + " " + (out[name] || "error:MISSING") + "\\n");
  }
}
try { fs.readFileSync(dataFile); out["data-root-read"] = "allowed"; }
catch (e) { out["data-root-read"] = kind(e); }
try { fs.writeFileSync(outsideFile, "x"); out["write-outside"] = "allowed"; }
catch (e) { out["write-outside"] = kind(e); }
try { fs.writeFileSync(insideFile, "x"); out["write-inside"] = "allowed"; }
catch (e) { out["write-inside"] = kind(e); }
try { process.kill(Number(pid), "SIGUSR1"); out.signal = "allowed"; }
catch (e) { out.signal = kind(e); }
let pending = 2;
function done() { if (--pending === 0) finish(); }
function connect(opts, name) {
  const socket = net.connect(opts);
  const timer = setTimeout(() => {
    socket.destroy();
    if (!out[name]) out[name] = "error:TIMEOUT";
    done();
  }, 2000);
  socket.once("connect", () => { clearTimeout(timer); out[name] = "allowed"; socket.end(); done(); });
  socket.once("error", (e) => { clearTimeout(timer); out[name] = kind(e); done(); });
}
connect({ host: "127.0.0.1", port: Number(port) }, "denied-port");
connect({ path: sock }, "unix-socket");
`;

/** Empty listener. A failed sandbox must not start the Node debugger on SIGUSR1. */
function keepDebuggerOff(): void {}

async function existingPaths(paths: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const real = await realpath(path);
      if (!out.includes(real)) out.push(real);
    } catch {
      /* missing or unreadable */
    }
  }
  return out;
}

function listen(
  server: ReturnType<typeof createServer>,
  pathOrPort: string | number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    if (typeof pathOrPort === "number") server.listen(pathOrPort, "127.0.0.1", () => resolve());
    else server.listen(pathOrPort, () => resolve());
  });
}

interface CanarySpec {
  helper: string;
  readRoots: readonly string[];
  pathEnv: string;
  /** Linux: exit 126 or a `boof-sandbox:` line means the helper refused to exec. */
  linuxHelper: boolean;
}

/**
 * Five denials and one allowed write, through whichever backend is registered.
 * Tests inject a probe list instead of calling this.
 */
async function runCanary(opts: CanarySpec): Promise<SelfTestProbeResult[]> {
  // realpath so the canary's paths match the grant. On macOS tmpdir() is
  // /var/folders, whose real path is /private/var/folders; Seatbelt matches
  // the spelling the syscall presents, and the profile allows both.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "boof-sandbox-canary-")));
  const insideDir = join(scratch, "inside");
  const outsideDir = join(scratch, "outside");
  const dataDir = join(scratch, "data");
  const sockPath = join("/tmp", `bs${randomBytes(4).toString("hex")}.sock`);
  const tcp = createServer();
  const unix = createServer();
  process.on("SIGUSR1", keepDebuggerOff);
  try {
    await mkdir(insideDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, "secret"), "secret");
    const insideFile = join(insideDir, "ok");
    const outsideFile = join(outsideDir, "no");
    const dataFile = join(dataDir, "secret");
    await listen(tcp, 0);
    const port = (tcp.address() as AddressInfo).port;
    await listen(unix, sockPath);
    const readExec = await existingPaths(opts.readRoots);
    const readWrite = await existingPaths([...SANDBOX_DEVICES, insideDir]);
    const policy: SandboxLaunchPolicy = {
      version: 1,
      readExec,
      readWrite,
      denyTcpPorts: [port],
      env: {
        PATH: opts.pathEnv,
        HOME: insideDir,
        TMPDIR: insideDir,
        UV_USE_IO_URING: "0",
        LANG: "C",
      },
    };
    const res = await execCommand(
      process.execPath,
      [
        "-e",
        CANARY,
        dataFile,
        outsideFile,
        insideFile,
        String(port),
        sockPath,
        String(process.pid),
      ],
      {
        cwd: insideDir,
        timeoutMs: 15000,
        env: policy.env,
        launch: { kind: "sandbox", policy, helper: opts.helper },
      },
    );
    if (opts.linuxHelper && (res.code === 126 || res.stderr.includes("boof-sandbox:"))) {
      const reason =
        res.stderr.replace(/boof-sandbox:\s*/g, "").trim() ||
        "self-test: helper refused the canary";
      throw new SandboxUnavailableError(reason);
    }
    if (res.timedOut) throw new SandboxUnavailableError("self-test: canary timed out");
    const results = res.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const space = line.indexOf(" ");
        return { id: line.slice(0, space), outcome: line.slice(space + 1) };
      });
    if (results.length < SELF_TEST_PROBES.length) {
      const detail = res.stderr.trim().slice(0, 300);
      throw new SandboxUnavailableError(
        detail ? `self-test: canary did not finish: ${detail}` : "self-test: canary did not finish",
      );
    }
    return results;
  } finally {
    process.off("SIGUSR1", keepDebuggerOff);
    tcp.close();
    unix.close();
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    await rm(sockPath, { force: true }).catch(() => {});
  }
}

/** Linux canary. The helper is `boof-sandbox`. */
export async function runRealProbes(opts: {
  helper: string;
  env: NodeJS.ProcessEnv;
}): Promise<SelfTestProbeResult[]> {
  const nodeDir = dirname(await realpath(process.execPath));
  return runCanary({
    helper: opts.helper,
    readRoots: [...LINUX_SYSTEM_ROOTS, ...LINUX_LIB_PATHS, nodeDir],
    pathEnv: opts.env.PATH ?? "/usr/bin:/bin",
    linuxHelper: true,
  });
}

/**
 * macOS canary. The registered applier runs `sandbox-exec`. `sandboxExec` is recorded on the
 * launch for the same shape as Linux; the darwin applier uses its own binary path.
 * The Node install prefix is granted so the canary can map its own libraries.
 */
export async function runDarwinProbes(opts: {
  env: NodeJS.ProcessEnv;
  sandboxExec: string;
}): Promise<SelfTestProbeResult[]> {
  const realNode = await realpath(process.execPath);
  const nodeDirs = [dirname(process.execPath), dirname(realNode)];
  const roots: string[] = [...DARWIN_SYSTEM_ROOTS];
  for (const dir of nodeDirs) {
    if (!roots.includes(dir)) roots.push(dir);
    const prefix = dirname(dir);
    // The Node prefix holds the binary's sibling libraries. Never grant `/`.
    if (prefix !== "/" && prefix !== dir && !roots.includes(prefix)) roots.push(prefix);
  }
  return runCanary({
    helper: opts.sandboxExec,
    readRoots: roots,
    pathEnv: opts.env.PATH ?? "/usr/bin:/bin",
    linuxHelper: false,
  });
}
