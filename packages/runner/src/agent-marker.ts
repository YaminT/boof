import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const AGENT_MARKER_ENV = "BOOF_RUNNER_AGENT_OF";

/**
 * Realpath of the longest existing prefix, with the missing remainder appended. The input is
 * already lexically collapsed (`resolve`), so `..` never reaches the kernel after a symlink.
 */
function realpathOrPrefix(absolute: string): string {
  try {
    return realpathSync.native(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(realpathOrPrefix(parent), basename(absolute));
  }
}

/** The form the stores build paths from (lexical `..` collapse), then resolved through symlinks. */
function canonicalRoot(dataRoot: string): string {
  return realpathOrPrefix(resolve(dataRoot));
}

function hash(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 32);
}

/** Stable across path aliases, but deliberately scoped to one data root. */
export function agentMarkerFor(dataRoot: string): string {
  return hash(canonicalRoot(dataRoot));
}

/**
 * True when the marker matches the root in any form a caller could mean it: canonical, lexical
 * (`resolve`), or the kernel's own reading of the raw string.
 */
export function isAgentOf(env: NodeJS.ProcessEnv, dataRoot: string): boolean {
  const marker = env[AGENT_MARKER_ENV];
  if (!marker) return false;
  const forms = [canonicalRoot(dataRoot), resolve(dataRoot)];
  try {
    forms.push(realpathSync.native(dataRoot));
  } catch {
    /* raw path does not exist for the kernel */
  }
  return forms.some((f) => hash(f) === marker);
}
