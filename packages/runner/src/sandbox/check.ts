import { existsSync } from "node:fs";
import { backendFor, type SandboxBackendName } from "@boof/heart";
import { darwinSandboxStatus } from "./backend-darwin.js";
import { boofSandboxHelperPath } from "./backend-linux.js";
import {
  judgeSelfTest,
  readFakeAbi,
  readHelperAbi,
  runRealProbes,
  type SelfTestProbeResult,
} from "./selftest.js";

/** What `sandbox check` and the settings switch share. `ok` means `enforce` would work. */
export interface SandboxCheckReport {
  ok: boolean;
  backend: SandboxBackendName;
  abi: number | null;
  reason: string;
  probes: readonly SelfTestProbeResult[];
}

export interface SandboxCheckDeps {
  platform?: NodeJS.Platform;
  /** When set, fake ABI and the helper override are read from here and not from `process.env`. */
  env?: NodeJS.ProcessEnv;
  helperExists?: (path: string) => boolean;
  helperPath?: (env: NodeJS.ProcessEnv) => string;
  spawn?: Parameters<typeof readHelperAbi>[1];
  probes?: (req: { helper: string; abi: number }) => Promise<readonly SelfTestProbeResult[]>;
}

function stripped(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^sandbox_unavailable:\s*/, "");
}

/**
 * Whether `enforce` would work on this machine. Does not change the stored status and does not
 * throw: a missing helper, a low ABI, or a failed probe is `ok: false` with the same reason the
 * status gate uses. `mode: off` never calls this.
 */
export async function assessSandbox(deps: SandboxCheckDeps = {}): Promise<SandboxCheckReport> {
  const platform = deps.platform ?? process.platform;
  const backend = backendFor(platform);
  const fail = (
    reason: string,
    abi: number | null = null,
    probes: readonly SelfTestProbeResult[] = [],
  ): SandboxCheckReport => ({ ok: false, backend, abi, reason, probes });
  try {
    if (platform === "darwin") return fail(darwinSandboxStatus().reason);
    if (platform === "win32") {
      return fail("Windows has no sandbox backend; enforce cannot run agents");
    }
    if (platform !== "linux") return fail(`unsupported sandbox platform "${platform}"`);
    const env = deps.env ?? process.env;
    const fake = readFakeAbi(env);
    if (fake.kind === "bad") return fail("BOOF_SANDBOX_FAKE_ABI is not an integer");
    if (fake.kind === "n" && fake.n < 4) return fail(`landlock abi ${fake.n} is below 4`, fake.n);
    const helper = (deps.helperPath ?? boofSandboxHelperPath)(env);
    if (!(deps.helperExists ?? existsSync)(helper)) {
      return fail("boof-sandbox helper is missing", fake.kind === "n" ? fake.n : null);
    }
    const abi = fake.kind === "n" ? fake.n : await readHelperAbi(helper, deps.spawn);
    if (abi < 4) return fail(`landlock abi ${abi} is below 4`, abi);
    const probes = deps.probes
      ? await deps.probes({ helper, abi })
      : await runRealProbes({ helper, env });
    const judged = judgeSelfTest(probes, abi);
    return { ok: judged.ok, backend: "linux", abi, reason: judged.reason, probes };
  } catch (err) {
    return fail(stripped(err));
  }
}

/** Text and exit code for `boof-runner sandbox check`. Exit 0 only when `enforce` would work. */
export function formatSandboxCheck(report: SandboxCheckReport): {
  stdout: string;
  stderr: string;
  code: number;
} {
  const lines = [
    `backend: ${report.backend}`,
    `abi: ${report.abi === null ? "-" : String(report.abi)}`,
    ...report.probes.map((probe) => `${probe.id}: ${probe.outcome}`),
  ];
  if (report.ok && report.reason) lines.push(`reason: ${report.reason}`);
  const stdout = `${lines.join("\n")}\n`;
  if (report.ok) return { stdout, stderr: "", code: 0 };
  return { stdout, stderr: report.reason ? `${report.reason}\n` : "", code: 1 };
}
