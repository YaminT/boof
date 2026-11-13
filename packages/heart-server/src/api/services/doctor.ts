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
