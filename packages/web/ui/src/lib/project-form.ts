import { toKebabId } from "@boof-runner/shared/ids";
import type { CreateProjectInput } from "../api.js";

export type ProjectPathMode = "auto" | "new" | "existing";

export interface ProjectFormState {
  name: string;
  mode: ProjectPathMode;
  directory: string;
  brief: string;
  confirm: boolean;
}

export const EMPTY_PROJECT_FORM: ProjectFormState = {
  name: "",
  mode: "auto",
  directory: "",
  brief: "",
  confirm: false,
};

export type ProjectFormIssue = "name" | "directory" | "brief";

/** What stops submission: auto needs a name; new/existing need a directory; auto/new need a brief. */
export function projectFormIssues(s: ProjectFormState): ProjectFormIssue[] {
  const issues: ProjectFormIssue[] = [];
  if (s.mode === "auto" && !s.name.trim()) issues.push("name");
  if (s.mode !== "auto" && !s.directory.trim()) issues.push("directory");
  if (s.mode !== "existing" && !s.brief.trim()) issues.push("brief");
  return issues;
}

export function toCreateProjectInput(s: ProjectFormState): CreateProjectInput {
  const name = s.name.trim();
  const brief = s.brief.trim();
  const directory = s.directory.trim();
  const path: NonNullable<CreateProjectInput["path"]> =
    s.mode === "auto"
      ? { mode: "auto" }
      : s.mode === "existing"
        ? { mode: "existing", directory }
        : { mode: "new", directory, ...(s.confirm ? { confirm: true as const } : {}) };
  return { ...(name ? { name } : {}), path, ...(brief ? { brief } : {}) };
}

/** True for the API error code that asks for confirmation. */
export function needsConfirm(code: string | undefined): boolean {
  return code === "directory_not_empty";
}

export function submitLabel(mode: ProjectPathMode, busy: boolean): string {
  if (mode === "existing") return busy ? "Adding…" : "Add project";
  return busy ? "Creating…" : "Create project";
}

export function autoPathHint(projectsRoot: string | undefined, name: string): string {
  return `${projectsRoot ?? "~/boof-projects"}/${toKebabId(name) || "<id>"}`;
}
