/**
 * How a child is started. Required on every `execCommand` call. There is no default: a missing
 * launch is a refusal, not an unsandboxed spawn. `direct` is today's spawn. `sandbox` is the OS
 * sandbox; the runner's backend turns the policy into a helper argv and a policy pipe.
 */

export type SandboxMode = "off" | "enforce";
export type SandboxBackendName = "none" | "linux" | "darwin";
export type SandboxState = "off" | "ok" | "unavailable";

/** What `runner.status` reports. `reason` is empty when `state` is `ok` and signals are scoped. */
export interface SandboxStatus {
  mode: SandboxMode;
  backend: SandboxBackendName;
  state: SandboxState;
  reason: string;
}

/**
 * Policy carried on a sandbox launch. `env` is applied by the launcher. The helper receives the
 * other fields only: it rejects an `env` field.
 */
export interface SandboxLaunchPolicy {
  version: 1;
  readExec: string[];
  readWrite: string[];
  denyTcpPorts: number[];
  env: Record<string, string>;
}

export type CommandLaunch =
  { kind: "direct" } | { kind: "sandbox"; policy: SandboxLaunchPolicy; helper: string };

/** The pipe the parent writes the policy JSON to (the child's fd 3). */
export interface SandboxPolicyPipe {
  write(chunk: string): unknown;
  end(): void;
  on?(event: "error", listener: (err: unknown) => void): void;
}

export interface SandboxChild {
  /** Index 3 is the policy pipe. Typed loosely so a real child process is assignable. */
  stdio?: ReadonlyArray<unknown>;
  kill?(signal?: NodeJS.Signals): boolean | void;
}

/** What the sandbox backend returns. `deliver` writes the policy. It does not spawn. */
export interface SandboxSpawnPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe", "pipe"];
  deliver(child: SandboxChild): void;
}

export type SandboxApplier = (
  launch: Extract<CommandLaunch, { kind: "sandbox" }>,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
) => SandboxSpawnPlan;

let applier: SandboxApplier | undefined;

/** The runner registers its backend on import. Heart never imports the runner. */
export function setSandboxApplier(fn: SandboxApplier | undefined): void {
  applier = fn;
}

export function sandboxApplier(): SandboxApplier | undefined {
  return applier;
}

/**
 * The step cannot start inside the sandbox. `code` is `sandbox_unavailable`. The message does not
 * say "temporarily unavailable": that phrase is what a transient tool failure looks like, and this
 * failure is not retried.
 */
export class SandboxUnavailableError extends Error {
  readonly code = "sandbox_unavailable" as const;

  constructor(reason: string) {
    super(`sandbox_unavailable: ${reason}`);
    this.name = "SandboxUnavailableError";
  }
}

export function backendFor(platform: NodeJS.Platform): SandboxBackendName {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "darwin";
  return "none";
}

/** `mode: off`. Spawn arguments stay as they are today. The self-test does not run. */
export function sandboxOffStatus(platform: NodeJS.Platform): SandboxStatus {
  return {
    mode: "off",
    backend: backendFor(platform),
    state: "off",
    reason: "agents are not sandboxed",
  };
}

export function sandboxSettingsFingerprint(sandbox: {
  mode: string;
  readPaths: readonly string[];
  writePaths: readonly string[];
  denyTcpPorts: readonly number[];
}): string {
  return JSON.stringify({
    mode: sandbox.mode,
    readPaths: sandbox.readPaths,
    writePaths: sandbox.writePaths,
    denyTcpPorts: sandbox.denyTcpPorts,
  });
}

interface StoredSandbox {
  status: SandboxStatus;
  fingerprint: string;
}

let stored: StoredSandbox = {
  status: sandboxOffStatus("linux"),
  fingerprint: "",
};

/** The last self-test result kept in this process. */
export function sandboxStatus(): SandboxStatus {
  return stored.status;
}

export function sandboxStoredFingerprint(): string {
  return stored.fingerprint;
}

export function setSandboxStatus(status: SandboxStatus, fingerprint: string): void {
  stored = { status, fingerprint };
}

export function resetSandboxStatus(): void {
  stored = { status: sandboxOffStatus("linux"), fingerprint: "" };
}

/**
 * Status for these settings. A matching refresh wins. `off` with no refresh still says agents are
 * not sandboxed. `enforce` with no passing refresh is unavailable: nothing is sandboxed by guess.
 */
export function sandboxStatusFor(
  sandbox: {
    mode: SandboxMode;
    readPaths: readonly string[];
    writePaths: readonly string[];
    denyTcpPorts: readonly number[];
  },
  platform: NodeJS.Platform,
): SandboxStatus {
  const fingerprint = sandboxSettingsFingerprint(sandbox);
  if (stored.fingerprint === fingerprint && stored.status.mode === sandbox.mode) {
    return stored.status;
  }
  if (sandbox.mode === "off") return sandboxOffStatus(platform);
  return {
    mode: "enforce",
    backend: backendFor(platform),
    state: "unavailable",
    reason: "sandbox self-test has not run",
  };
}
