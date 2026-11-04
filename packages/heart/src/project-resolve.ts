import { isAbsolute, resolve } from "node:path";
import { isGitRepo, pruneStaleWorktrees, repoCommonDir } from "./git.js";
import { ProjectStore } from "./project-store.js";
import { SettingsStore } from "./settings.js";
import type { Project } from "./schema.js";

const abs = (p: string): string => (isAbsolute(p) ? p : resolve(process.cwd(), p));

/** Which project a command acts on: an id, a repository directory, or the data root's default. */
export interface ProjectRef {
  /** Project id. */
  project?: string;
  /** Repository directory: the project with this realpath, registered on first use. */
  repo?: string;
}

/** Thrown for a bad project reference; the message is for the user. */
export class ProjectResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectResolutionError";
  }
}

/**
 * Resolve the project for a headless command. `project` wins, then `repo` (realpath lookup;
 * an unknown repository is registered and its new id printed), then
 * `settings.defaultProject`. Never touches settings.json.
 */
export async function resolveProject(
  root: string,
  ref: ProjectRef,
  out: (chunk: string) => void = (c) => process.stdout.write(c),
): Promise<Project> {
  const projects = new ProjectStore(root, { isGitRepo, repoCommonDir });
  let project: Project | null = null;
  if (ref.project) {
    project = await projects.get(ref.project);
    if (!project) throw new ProjectResolutionError(`Project not found: ${ref.project}`);
  } else if (ref.repo) {
    const dir = abs(ref.repo);
    project = await projects.findByDirectory(dir);
    if (!project) {
      try {
        project = await projects.create({ workingDirectory: dir, origin: { kind: "cli" } });
      } catch (err) {
        throw new ProjectResolutionError(err instanceof Error ? err.message : String(err));
      }
      const added = project;
      await pruneStaleWorktrees(added.workingDirectory).catch((err) =>
        console.error(`could not prune worktrees of project ${added.id}:`, err),
      );
      out(`Registered project '${project.id}' for ${project.workingDirectory}\n`);
    }
  } else {
    const id = (await new SettingsStore(root).load()).defaultProject;
    if (!id) {
      throw new ProjectResolutionError(
        "No project: pass --project <id> or --repo <dir>, or set a default with `project add <dir> --default`.",
      );
    }
    project = await projects.get(id);
    if (!project) throw new ProjectResolutionError(`Default project not found: ${id}`);
  }
  if (project.archived) throw new ProjectResolutionError(`Project '${project.id}' is archived.`);
  if (!project.workingDirectory) {
    throw new ProjectResolutionError(
      `Project '${project.id}' has no working directory; set one with the UI or PUT /api/projects/${project.id}.`,
    );
  }
  return project;
}
