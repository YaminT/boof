import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxUnavailableError, type SandboxChild, type SandboxSpawnPlan } from "@boof/heart";
import type { CommandLaunch, SandboxLaunchPolicy } from "@boof/heart";

/** Read by the helper; set from the server process only. */
const NPROC_KNOBS = ["BOOF_SANDBOX_NPROC_FLOOR", "BOOF_SANDBOX_NPROC_HEADROOM"] as const;

const POLICY_KEYS = ["version", "readExec", "readWrite", "denyTcpPorts", "env"] as const;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HELPER_NAME = "boof-sandbox";

/**
 * This file after bundling. The desktop CJS bundle rewrites the body to `__filename`
 * (import.meta.url is empty there). ESM keeps this: vitest and the CLI bundle.
 */
function sandboxModuleFile(): string {
  // cjs-bundle-filename
  return typeof __filename === "string" && __filename.length > 0
    ? __filename
    : fileURLToPath(import.meta.url);
}

/**
 * `packages/sandbox-linux/dist/boof-sandbox` when `start` is inside a checkout that has built it.
 * Stops after a few parents so a packaged app does not walk out to another install.
 */
function sandboxDistFromCheckout(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "packages", "sandbox-linux", "dist", HELPER_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Helper binary. An explicit `BOOF_SANDBOX_HELPER` path wins. Otherwise the file beside the
 * bundle wins, then the checkout's `packages/sandbox-linux/dist`. Never `PATH`.
 */
export function resolveBoofSandboxHelper(moduleFile: string, env: NodeJS.ProcessEnv): string {
  const override = env.BOOF_SANDBOX_HELPER;
  if (typeof override === "string" && override.length > 0) return override;
  const beside = join(dirname(moduleFile), HELPER_NAME);
  if (existsSync(beside)) return beside;
  return sandboxDistFromCheckout(dirname(moduleFile)) ?? beside;
}

/** Helper for this process. See {@link resolveBoofSandboxHelper}. */
export function boofSandboxHelperPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBoofSandboxHelper(sandboxModuleFile(), env);
}

function corrupt(): SandboxUnavailableError {
  return new SandboxUnavailableError("sandbox policy is corrupt");
}

function absolutePath(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  if (!value.startsWith("/")) return false;
  if (
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.includes("\\")
  ) {
    return false;
  }
  return value.split("/").every((part) => part !== "." && part !== "..");
}

function validPolicy(policy: unknown): policy is SandboxLaunchPolicy {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return false;
  const record = policy as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== POLICY_KEYS.length || POLICY_KEYS.some((key) => !keys.includes(key))) {
    return false;
  }
  if (record.version !== 1) return false;
  if (!Array.isArray(record.readExec) || !record.readExec.every(absolutePath)) return false;
  if (!Array.isArray(record.readWrite) || !record.readWrite.every(absolutePath)) return false;
  if (
    !Array.isArray(record.denyTcpPorts) ||
    !record.denyTcpPorts.every(
      (port) => typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535,
    )
  ) {
    return false;
  }
  const env = record.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) return false;
  return Object.entries(env as Record<string, unknown>).every(
    ([key, value]) => ENV_NAME.test(key) && typeof value === "string" && !value.includes("\0"),
  );
}

/**
 * Turn a sandbox launch into the helper argv and the policy pipe. Does not spawn. The helper
 * receives the policy without `env`; the launcher applies `env` on the child.
 */
export function planLinuxSandbox(
  launch: Extract<CommandLaunch, { kind: "sandbox" }>,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
): SandboxSpawnPlan {
  if (!validPolicy(launch.policy)) throw corrupt();
  if (!launch.helper || !existsSync(launch.helper)) {
    throw new SandboxUnavailableError("boof-sandbox helper is missing");
  }
  const policy = launch.policy;
  const policyJson = JSON.stringify({
    version: policy.version,
    readExec: policy.readExec,
    readWrite: policy.readWrite,
    denyTcpPorts: policy.denyTcpPorts,
  });
  const childEnv: NodeJS.ProcessEnv = { ...(env ?? process.env), ...policy.env };
  // The helper reads its process-count knobs from its own environment. Only the server's own
  // environment may set them: an agent or step environment (`env`, `policy.env`) must not raise
  // the cap, so those values are dropped and the server's are copied back.
  for (const name of NPROC_KNOBS) {
    delete childEnv[name];
    const trusted = process.env[name];
    if (trusted !== undefined) childEnv[name] = trusted;
  }
  return {
    command: launch.helper,
    args: ["--policy-fd", "3", "--", command, ...args],
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    deliver(child: SandboxChild) {
      const pipe = child.stdio?.[3] as
        | {
            write?: (chunk: string) => unknown;
            end?: () => void;
            on?: (event: "error", listener: (err: unknown) => void) => void;
          }
        | null
        | undefined;
      if (!pipe || typeof pipe.write !== "function" || typeof pipe.end !== "function") {
        try {
          child.kill?.("SIGKILL");
        } catch {
          /* already gone */
        }
        throw new SandboxUnavailableError("sandbox policy pipe was not created");
      }
      pipe.on?.("error", () => {});
      pipe.write(policyJson);
      pipe.end();
    },
  };
}
