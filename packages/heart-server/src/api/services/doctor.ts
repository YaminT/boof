import type { PoolStatus } from "@boof/owlish";
import { execFile } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Where in Settings a failed check is fixed (the UI maps it to a link). */
export type FixPage = "agents" | "gateway" | "projects" | "sandbox" | "general";

export interface DoctorCheck {
  id: "agents" | "gateway" | "projectsRoot" | "git" | "dataRoot" | "sandbox";
  label: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fixHint?: string;
  fixPage?: FixPage;
  /** A one-line rule that applies whatever the result (the terms note of the account pool). */
  note?: string;
}

export interface ToolReadiness {
  ready: boolean;
  readyReason: string;
  fixHint?: string;
  fixPage?: FixPage;
}

/** Whether `git` runs. Free: `git --version`. */
export async function gitCheck(): Promise<DoctorCheck> {
  try {
    const { stdout } = await run("git", ["--version"], { timeout: 5000 });
    return { id: "git", label: "git", status: "pass", message: stdout.trim() };
  } catch {
    return {
      id: "git",
      label: "git",
      status: "fail",
      message: "git was not found on this computer; boof needs it for task worktrees.",
      fixHint: "Install git and check again.",
    };
  }
}

/** Whether `dir` exists and can be written to. */
export async function writableDirCheck(
  id: "dataRoot" | "projectsRoot",
  label: string,
  dir: string,
): Promise<DoctorCheck> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) throw new Error("not a directory");
    await access(dir, constants.W_OK);
    return { id, label, status: "pass", message: dir };
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    // A projects folder that does not exist yet is created when the first project is added.
    if (id === "projectsRoot" && missing)
      return {
        id,
        label,
        status: "warn",
        message: `${dir} does not exist yet; it is created with the first project.`,
        fixPage: "projects",
      };
    // A data folder that does not exist yet is created when the server first starts.
    if (id === "dataRoot" && missing)
      return {
        id,
        label,
        status: "warn",
        message: `${dir} does not exist yet; it is created when boof first starts.`,
        fixPage: "general",
      };
    return {
      id,
      label,
      status: "fail",
      message: `${dir} is not a writable folder.`,
      fixHint: "Make it writable, or choose another folder.",
      fixPage: id === "projectsRoot" ? "projects" : "general",
    };
  }
}

/** The terms rule, shown with the account pool check in every mode. */
export const POOL_TERMS_NOTE =
  "boof's built-in account pool takes Anthropic API keys only. Anthropic does not allow third-party tools to store or route Claude subscription sign-ins; Claude Code keeps using your own sign-in.";

export interface PoolCheckInput {
  mode: "internal" | "better-ccflare" | "none";
  /** Whether any coding agent is ready (a missing pool only fails when none is). */
  anyReady: boolean;
  pool: {
    status: "absent" | "unreachable" | "ok" | "degraded" | "unhealthy";
    configured: number | null;
    routable: number | null;
    nextAvailableAt: string | null;
    reason: string | null;
  };
  /** The words of the better-ccflare messages (unchanged by this check). */
  legacyMessage: (status: PoolStatus["status"], reason: string | null) => string;
}

/** The "gateway" check: what the account pool looks like in each mode (plan section 4, Doctor table). */
export function poolCheck(i: PoolCheckInput): DoctorCheck {
  const note = POOL_TERMS_NOTE;
  if (i.mode === "none")
    return {
      id: "gateway",
      label: "Account pool",
      status: i.anyReady ? "warn" : "fail",
      message: "No account pool; agents use their own sign-in.",
      fixHint: "Set up the account pool in Settings, or sign in to your coding agent.",
      fixPage: "gateway",
      note,
    };
  if (i.mode === "internal") {
    const total = i.pool.configured ?? 0;
    const usable = i.pool.routable ?? 0;
    if (total === 0)
      return {
        id: "gateway",
        label: "Account pool",
        status: "warn",
        message: "No accounts yet.",
        fixHint: "Add an Anthropic API key.",
        fixPage: "gateway",
        note,
      };
    if (usable === 0)
      return {
        id: "gateway",
        label: "Account pool",
        status: "warn",
        message: `All ${total} account${total === 1 ? " is" : "s are"} paused or limited${
          i.pool.nextAvailableAt ? `; the first is usable again at ${i.pool.nextAvailableAt}` : ""
        }.`,
        fixPage: "gateway",
        note,
      };
    return {
      id: "gateway",
      label: "Account pool",
      status: "pass",
      message: `${usable} of ${total} account${total === 1 ? "" : "s"} usable`,
      note,
    };
  }
  const { pool } = i;
  const label = "better-ccflare gateway";
  if (pool.status === "ok" || pool.status === "degraded")
    return {
      id: "gateway",
      label,
      status: pool.status === "ok" ? "pass" : "warn",
      message: i.legacyMessage(pool.status, pool.reason),
      ...(pool.status === "ok" ? {} : { fixPage: "gateway" as const }),
      note,
    };
  return {
    id: "gateway",
    label,
    status: "fail",
    message: i.legacyMessage(pool.status, pool.reason),
    fixHint: "Check the gateway address and that it is running.",
    fixPage: "gateway",
    note,
  };
}
