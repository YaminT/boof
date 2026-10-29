import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, relative, isAbsolute } from "node:path";
import { atomicWrite, readText, withFileLock } from "./atomic.js";
import { toKebabId, uniqueKebabId } from "./ids.js";
import { assertKebabId, dataRootPaths, projectPaths, statusDir } from "./paths.js";
import { nowIso } from "./runtime.js";
import { ProjectSchema, type Project, type ProjectOrigin, type ProjectPatch } from "./schema.js";
import { TaskStore } from "./store.js";

export type ProjectErrorCode =
  | "not_found"
  | "directory_missing"
  | "not_git_repo"
  | "inside_data_root"
  | "duplicate"
  | "id_taken"
  | "has_running_task";

/** A project operation was refused; `code` is stable for API mapping. */
export class ProjectError extends Error {
  constructor(
    public readonly code: ProjectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectError";
  }
}

/** Decides whether a directory is a git work tree; injected so shared does not depend on runner. */
export type RepoValidator = (dir: string) => Promise<boolean>;

export interface ProjectStoreOptions {
  /** Called by create/update(workingDirectory); without it no git check is made. */
  isGitRepo?: RepoValidator;
}

export interface CreateProjectInput {
  workingDirectory: string;
  /** Explicit id (kebab); default derived from the directory name. */
  id?: string;
  name?: string;
  defaultBase?: string;
  labels?: string[];
  origin?: ProjectOrigin;
  roles?: Project["roles"];
  review?: Project["review"];
  worktree?: Project["worktree"];
  retries?: Project["retries"];
  budget?: Project["budget"];
  planWriteBack?: boolean;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** File-backed registry of projects under <root>/projects/<id>/project.json. */
export class ProjectStore {
  private readonly isGitRepo?: RepoValidator;

  constructor(
    private readonly root: string,
    opts: ProjectStoreOptions = {},
  ) {
    this.isGitRepo = opts.isGitRepo;
  }

  /** Directory to hand to TaskStore / AttachmentStore / UsageStore for project `id`. */
  dir(id: string): string {
    return projectPaths(this.root, id).dir;
  }

  /** Projects sorted by id; archived ones only with `includeArchived`. Unreadable entries are skipped. */
  async list(opts: { includeArchived?: boolean } = {}): Promise<Project[]> {
    let names: string[] = [];
    try {
      const entries = await readdir(dataRootPaths(this.root).projects, { withFileTypes: true });
      names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
    const out: Project[] = [];
    for (const name of names.sort()) {
      let project: Project | null = null;
      try {
        project = await this.get(name);
      } catch {
        project = null;
      }
      if (project && (opts.includeArchived || !project.archived)) out.push(project);
    }
    return out;
  }

  /** The project, or null when it does not exist. Throws InvalidIdError for a non-kebab id. */
  async get(id: string): Promise<Project | null> {
    const path = projectPaths(this.root, id).json;
    let text: string;
    try {
      text = await readText(path);
    } catch {
      return null;
    }
    return ProjectSchema.parse(JSON.parse(text));
  }

  async require(id: string): Promise<Project> {
    const project = await this.get(id);
    if (!project) throw new ProjectError("not_found", `Project not found: ${id}`);
    return project;
  }

  /** Resolve and vet a working directory: exists, git work tree, outside the data root. */
  private async vetDirectory(dir: string, exceptId?: string): Promise<string> {
    let real: string;
    try {
      real = await realpath(dir);
    } catch {
      throw new ProjectError("directory_missing", `Directory does not exist: ${dir}`);
    }
    if (!(await isDirectory(real))) {
      throw new ProjectError("directory_missing", `Not a directory: ${dir}`);
    }
    const dataRoot = await realpath(this.root).catch(() => this.root);
    if (isInside(dataRoot, real)) {
      throw new ProjectError("inside_data_root", `Directory is inside the data root: ${real}`);
    }
    if (this.isGitRepo && !(await this.isGitRepo(real))) {
      throw new ProjectError("not_git_repo", `Not a git repository: ${real}`);
    }
    const clash = (await this.list({ includeArchived: true })).find(
      (p) => p.id !== exceptId && p.workingDirectory === real,
    );
    if (clash) {
      throw new ProjectError("duplicate", `Directory is already project '${clash.id}': ${real}`);
    }
    return real;
  }

  /** Find the project whose working directory is the realpath of `dir`, if any. */
  async findByDirectory(
    dir: string,
    opts: { includeArchived?: boolean } = {},
  ): Promise<Project | null> {
    let real: string;
    try {
      real = await realpath(dir);
    } catch {
      return null;
    }
    const all = await this.list({ includeArchived: opts.includeArchived ?? true });
    return all.find((p) => p.workingDirectory === real) ?? null;
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const real = await this.vetDirectory(input.workingDirectory);
    const existing = (await this.list({ includeArchived: true })).map((p) => p.id);
    let id: string;
    if (input.id !== undefined) {
      id = assertKebabId(input.id);
      if (existing.includes(id))
        throw new ProjectError("id_taken", `Project id already exists: ${id}`);
    } else {
      id = uniqueKebabId(toKebabId(basename(real)) || "project", existing);
    }
    const now = nowIso();
    const project = ProjectSchema.parse({
      id,
      name: input.name?.trim() || basename(real) || id,
      workingDirectory: real,
      ...(input.defaultBase ? { defaultBase: input.defaultBase } : {}),
      ...(input.roles ? { roles: input.roles } : {}),
      ...(input.review ? { review: input.review } : {}),
      ...(input.worktree ? { worktree: input.worktree } : {}),
      ...(input.retries ? { retries: input.retries } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
      ...(input.planWriteBack !== undefined ? { planWriteBack: input.planWriteBack } : {}),
      labels: input.labels ?? [],
      origin: input.origin ?? { kind: "api" },
      created: now,
      updated: now,
    });
    await this.write(project);
    await this.ensureDirs(id);
    return project;
  }

  /** Apply a patch (null clears an optional field), re-vetting a changed working directory. */
  async update(id: string, patch: ProjectPatch): Promise<Project> {
    const path = projectPaths(this.root, id).json;
    return withFileLock(`${path}#mutate`, async () => {
      const current = await this.require(id);
      const next: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (value === null) delete next[key];
        else next[key] = value;
      }
      if (
        patch.workingDirectory !== undefined &&
        patch.workingDirectory !== current.workingDirectory
      ) {
        next.workingDirectory = await this.vetDirectory(patch.workingDirectory, id);
      }
      next.updated = nowIso();
      const project = ProjectSchema.parse(next);
      await withFileLock(path, () => atomicWrite(path, JSON.stringify(project, null, 2) + "\n"));
      return project;
    });
  }

  archive(id: string): Promise<Project> {
    return this.update(id, { archived: true });
  }

  unarchive(id: string): Promise<Project> {
    return this.update(id, { archived: false });
  }

  /** True when a task of the project is in `ongoing/`. */
  async hasRunningTask(id: string): Promise<boolean> {
    try {
      const entries = await readdir(statusDir(this.dir(id), "running"), { withFileTypes: true });
      return entries.some((e) => e.isDirectory());
    } catch {
      return false;
    }
  }

  /**
   * Remove a project: refused while a task runs. `purge` deletes its data directory
   * (tasks, usage, plans; never the repository); otherwise it is archived.
   */
  async remove(id: string, opts: { purge?: boolean } = {}): Promise<void> {
    await this.require(id);
    if (await this.hasRunningTask(id)) {
      throw new ProjectError("has_running_task", `Project ${id} has a running task`);
    }
    if (opts.purge) await rm(this.dir(id), { recursive: true, force: true });
    else await this.archive(id);
  }

  /** Create the project's task status directories. */
  async ensureDirs(id: string): Promise<void> {
    await mkdir(this.dir(id), { recursive: true });
    await new TaskStore(this.dir(id)).ensureDirs();
  }

  private async write(project: Project): Promise<void> {
    const path = projectPaths(this.root, project.id).json;
    await withFileLock(path, () => atomicWrite(path, JSON.stringify(project, null, 2) + "\n"));
  }
}
