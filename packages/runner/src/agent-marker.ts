import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export const AGENT_MARKER_ENV = "BOOF_RUNNER_AGENT_OF";

/** Stable across path aliases, but deliberately scoped to one data root. */
export function agentMarkerFor(dataRoot: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(dataRoot);
  } catch {
    canonical = resolve(dataRoot);
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export function isAgentOf(env: NodeJS.ProcessEnv, dataRoot: string): boolean {
  return env[AGENT_MARKER_ENV] === agentMarkerFor(dataRoot);
}
