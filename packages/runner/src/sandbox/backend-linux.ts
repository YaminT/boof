import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxUnavailableError, type SandboxChild, type SandboxSpawnPlan } from "@boof/heart";
import type { CommandLaunch, SandboxLaunchPolicy } from "@boof/heart";

const POLICY_KEYS = ["version", "readExec", "readWrite", "denyTcpPorts", "env"] as const;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Helper binary. `BOOF_SANDBOX_HELPER` overrides the path built next to this package. */
export function boofSandboxHelperPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BOOF_SANDBOX_HELPER;
  if (override && override.length > 0) return override;
  return join(dirname(fileURLToPath(import.meta.url)), "../../../sandbox-linux/dist/boof-sandbox");
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
