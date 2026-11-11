import {
  SandboxUnavailableError,
  sandboxOffStatus,
  sandboxSettingsFingerprint,
  sandboxStatus,
  sandboxStoredFingerprint,
  setSandboxApplier,
  setSandboxStatus,
  sandboxStatusFor,
  backendFor,
  type CommandLaunch,
  type SandboxMode,
  type SandboxStatus,
} from "@boof/heart";
import { planLinuxSandbox } from "./backend-linux.js";
import { assessSandbox, type SandboxCheckDeps } from "./check.js";

if (process.platform === "linux") setSandboxApplier(planLinuxSandbox);

export interface SandboxSettingsView {
  mode: SandboxMode;
  readPaths: readonly string[];
  writePaths: readonly string[];
  denyTcpPorts: readonly number[];
}

export type RefreshSandboxDeps = SandboxCheckDeps;

function reasonOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^sandbox_unavailable:\s*/, "");
}

function unavailable(platform: NodeJS.Platform, reason: string): SandboxStatus {
  return { mode: "enforce", backend: backendFor(platform), state: "unavailable", reason };
}

/**
 * Recompute `runner.status` sandbox fields. Does not throw: a failed self-test is `unavailable`,
 * and the server still starts. `mode: off` does not run the canary. A matching fingerprint is
 * reused unless `force` is set (a settings save).
 */
export async function refreshSandbox(
  settings: { runner: { sandbox: SandboxSettingsView } },
  deps: RefreshSandboxDeps = {},
  opts: { force?: boolean } = {},
): Promise<SandboxStatus> {
  const sandbox = settings.runner.sandbox;
  const platform = deps.platform ?? process.platform;
  const fingerprint = sandboxSettingsFingerprint(sandbox);
  try {
    if (
      !opts.force &&
      sandboxStoredFingerprint() === fingerprint &&
      sandboxStatus().mode === sandbox.mode
    ) {
      return sandboxStatus();
    }
    const status =
      sandbox.mode === "off"
        ? sandboxOffStatus(platform)
        : await enforceStatus(sandbox, platform, deps);
    setSandboxStatus(status, fingerprint);
    return status;
  } catch (err) {
    if (sandbox.mode === "off") {
      const off = sandboxOffStatus(platform);
      setSandboxStatus(off, fingerprint);
      return off;
    }
    const status = unavailable(platform, reasonOf(err));
    setSandboxStatus(status, fingerprint);
    return status;
  }
}

async function enforceStatus(
  _sandbox: SandboxSettingsView,
  platform: NodeJS.Platform,
  deps: RefreshSandboxDeps,
): Promise<SandboxStatus> {
  const report = await assessSandbox({ ...deps, platform });
  if (!report.ok) return unavailable(platform, report.reason);
  return { mode: "enforce", backend: "linux", state: "ok", reason: report.reason };
}

/**
 * Why an agent step must not start, or null when `mode` is off.
 * Until I1e builds a per-task policy, enforce with a passing self-test still returns
 * "sandbox policy is not ready for this step". There is no unsandboxed fallback.
 */
export function sandboxBlockReason(settings: {
  runner: { sandbox: SandboxSettingsView };
}): string | null {
  const sandbox = settings.runner.sandbox;
  if (sandbox.mode !== "enforce") return null;
  const status = sandboxStatusFor(sandbox, process.platform);
  if (status.state !== "ok") return status.reason;
  return "sandbox policy is not ready for this step";
}

/** Direct when the sandbox is off. Enforce throws `SandboxUnavailableError` before any spawn. */
export function prepareAgentLaunch(settings: {
  runner: { sandbox: SandboxSettingsView };
}): CommandLaunch {
  const reason = sandboxBlockReason(settings);
  if (reason) throw new SandboxUnavailableError(reason);
  return { kind: "direct" };
}

export { assessSandbox, type SandboxCheckReport } from "./check.js";
export { judgeSelfTest } from "./selftest.js";
export { planLinuxSandbox, boofSandboxHelperPath } from "./backend-linux.js";
export { darwinSandboxStatus } from "./backend-darwin.js";
