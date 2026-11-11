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
import { sandboxLaunchFor, type AgentLaunchContext } from "./runtime.js";

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
 * Why an agent must not start, or null when it may. `off` starts unsandboxed. `enforce` starts
 * only after the self-test passed; the per-step policy is built by {@link prepareAgentLaunch}.
 * There is no unsandboxed fallback.
 */
export function sandboxBlockReason(settings: {
  runner: { sandbox: SandboxSettingsView };
}): string | null {
  const sandbox = settings.runner.sandbox;
  if (sandbox.mode !== "enforce") return null;
  const status = sandboxStatusFor(sandbox, process.platform);
  if (status.state !== "ok") return status.reason;
  return null;
}

/**
 * Direct when the sandbox is off. Enforce throws `SandboxUnavailableError` before any spawn
 * when the self-test has not passed, or when the step context is missing. With a context, the
 * launch carries the per-step policy (git paths, agent home, cache, temp, git identity).
 */
export async function prepareAgentLaunch(
  settings: { runner: { sandbox: SandboxSettingsView } },
  ctx?: AgentLaunchContext,
): Promise<CommandLaunch> {
  if (settings.runner.sandbox.mode !== "enforce") return { kind: "direct" };
  const status = sandboxStatusFor(settings.runner.sandbox, process.platform);
  if (status.state !== "ok") throw new SandboxUnavailableError(status.reason);
  if (!ctx) throw new SandboxUnavailableError("sandbox policy is not ready for this step");
  return sandboxLaunchFor(settings, ctx);
}

export { assessSandbox, type SandboxCheckReport } from "./check.js";
export { judgeSelfTest } from "./selftest.js";
export { planLinuxSandbox, boofSandboxHelperPath } from "./backend-linux.js";
export { darwinSandboxStatus } from "./backend-darwin.js";
export {
  boofStateHome,
  buildRunPolicy,
  createRunTemp,
  dataRootHash,
  linkedWorktreeGit,
  readGitIdentity,
  reapCrashedRunTemps,
  removeRunTemp,
} from "./runtime.js";
export type { AgentLaunchContext } from "./runtime.js";
