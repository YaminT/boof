import { existsSync } from "node:fs";
import {
  SandboxUnavailableError,
  backendFor,
  sandboxOffStatus,
  sandboxSettingsFingerprint,
  sandboxStatus,
  sandboxStoredFingerprint,
  setSandboxApplier,
  setSandboxStatus,
  sandboxStatusFor,
  type CommandLaunch,
  type SandboxMode,
  type SandboxStatus,
} from "@boof/heart";
import { darwinSandboxStatus } from "./backend-darwin.js";
import { boofSandboxHelperPath, planLinuxSandbox } from "./backend-linux.js";
import { sandboxLaunchFor, type AgentLaunchContext } from "./runtime.js";
import {
  judgeSelfTest,
  readFakeAbi,
  readHelperAbi,
  runRealProbes,
  type SelfTestProbeResult,
} from "./selftest.js";

if (process.platform === "linux") setSandboxApplier(planLinuxSandbox);

export interface SandboxSettingsView {
  mode: SandboxMode;
  readPaths: readonly string[];
  writePaths: readonly string[];
  denyTcpPorts: readonly number[];
}

export interface RefreshSandboxDeps {
  platform?: NodeJS.Platform;
  /** When set, fake ABI and the helper override are read from here and not from `process.env`. */
  env?: NodeJS.ProcessEnv;
  helperExists?: (path: string) => boolean;
  helperPath?: (env: NodeJS.ProcessEnv) => string;
  spawn?: Parameters<typeof readHelperAbi>[1];
  probes?: (req: { helper: string; abi: number }) => Promise<readonly SelfTestProbeResult[]>;
}

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
  if (platform === "darwin") return darwinSandboxStatus();
  if (platform === "win32") {
    return unavailable(platform, "Windows has no sandbox backend; enforce cannot run agents");
  }
  if (platform !== "linux") {
    return unavailable(platform, `unsupported sandbox platform "${platform}"`);
  }
  const env = deps.env ?? process.env;
  const fake = readFakeAbi(env);
  if (fake.kind === "bad") {
    return unavailable(platform, "BOOF_SANDBOX_FAKE_ABI is not an integer");
  }
  if (fake.kind === "n" && fake.n < 4) {
    return unavailable(platform, `landlock abi ${fake.n} is below 4`);
  }
  const helper = (deps.helperPath ?? boofSandboxHelperPath)(env);
  const exists = (deps.helperExists ?? existsSync)(helper);
  if (!exists) return unavailable(platform, "boof-sandbox helper is missing");
  const abi = fake.kind === "n" ? fake.n : await readHelperAbi(helper, deps.spawn);
  if (abi < 4) return unavailable(platform, `landlock abi ${abi} is below 4`);
  const probes = deps.probes
    ? await deps.probes({ helper, abi })
    : await runRealProbes({ helper, env });
  const judged = judgeSelfTest(probes, abi);
  if (!judged.ok) return unavailable(platform, judged.reason);
  return { mode: "enforce", backend: "linux", state: "ok", reason: judged.reason };
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

export { judgeSelfTest, planLinuxSandbox, boofSandboxHelperPath, darwinSandboxStatus };
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
