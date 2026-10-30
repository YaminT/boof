import { lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { atomicWrite, readText, withFileLock } from "./atomic.js";
import { toKebabId, uniqueKebabId } from "./ids.js";
import { assertKebabId, dataRootPaths, projectPaths, statusDir } from "./paths.js";
import { isInsidePath, resolveUnbornPath } from "./project-path.js";
import { nowIso } from "./runtime.js";
import { ProjectSchema, type Project, type ProjectOrigin, type ProjectPatch } from "./schema.js";
import { TaskStore } from "./store.js";

export type ProjectErrorCode =
  | "not_found"
  | "directory_missing"
  | "not_git_repo"
  | "inside_data_root"
  | "duplicate"
  | "same_repo"
  | "id_taken"
  | "has_running_task"
  | "not_a_directory"
  | "directory_not_empty"
  | "directory_create_failed"
  | "directory_not_allowed";

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

/** Resolves the git common dir (realpath) of a directory, shared by a repository's linked worktrees; null when it is not in a repository. */
export type RepoCommonDir = (dir: string) => Promise<string | null>;

/** How `create` treats the directory: use an existing git work tree, make one at a path, or make one under a projects root. */
export type ProjectPathSpec =
  | { mode: "existing" }
  | { mode: "new"; confirm?: boolean }
  | { mode: "auto"; projectsRoot: string };

export interface ProjectStoreOptions {
  /** Called by create/update(workingDirectory); without it no git check is made. */
  isGitRepo?: RepoValidator;
  /** Called by create/update(workingDirectory) to refuse two projects in one repository. */
  repoCommonDir?: RepoCommonDir;
  /** Called on a new or auto directory after it is made; without it the directory is created but no repository is initialised. */
  initGitRepo?: (dir: string) => Promise<void>;
}

export interface CreateProjectInput {
  /** Required unless `path.mode === "auto"`. */
  workingDirectory?: string;
  /** Default `{ mode: "existing" }`. */
  path?: ProjectPathSpec;
  /** What the project is for (trimmed; stored only when non-empty). */
  brief?: string;
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

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** File-backed registry of projects under <root>/projects/<id>/project.json. */
export class ProjectStore {
  private readonly isGitRepo?: RepoValidator;
  private readonly repoCommonDir?: RepoCommonDir;
  private readonly initGitRepo?: (dir: string) => Promise<void>;

  constructor(
    private readonly root: string,
    opts: ProjectStoreOptions = {},
  ) {
    this.isGitRepo = opts.isGitRepo;
    this.repoCommonDir = opts.repoCommonDir;
    this.initGitRepo = opts.initGitRepo;
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
    if (isInsidePath(dataRoot, real)) {
      throw new ProjectError("inside_data_root", `Directory is inside the data root: ${real}`);
    }
    if (this.isGitRepo && !(await this.isGitRepo(real))) {
      throw new ProjectError("not_git_repo", `Not a git repository: ${real}`);
    }
    const others = (await this.list({ includeArchived: true })).filter((p) => p.id !== exceptId);
    const clash = others.find((p) => p.workingDirectory === real);
    if (clash) {
      throw new ProjectError("duplicate", `Directory is already project '${clash.id}': ${real}`);
    }
    if (this.repoCommonDir) {
      const common = await this.repoCommonDir(real);
      if (common !== null) {
        for (const other of others) {
          if (!other.workingDirectory) continue;
          if ((await this.repoCommonDir(other.workingDirectory)) === common) {
            throw new ProjectError(
              "same_repo",
              `Directory is in the repository of project '${other.id}' (${common}); two projects cannot share one repository`,
            );
          }
        }
      }
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

  /**
   * Make (or accept an empty) directory for a `new` or `auto` project. Refuses before creating
   * anything when the path is the filesystem root, the home directory or inside the data root, or
   * when an entry on the way (a dangling symlink, something unreadable) cannot be told apart from
   * absence. `created` is true only when this call made the directory.
   */
  private async prepareNewDirectory(
    target: string,
    opts: { confirm?: boolean },
  ): Promise<{ real: string; created: boolean }> {
    const { real, exists } = await resolveUnbornPath(target);
    const dataRoot = await realpath(this.root).catch(() => this.root);
    if (isInsidePath(dataRoot, real)) {
      throw new ProjectError("inside_data_root", `Directory is inside the data root: ${real}`);
    }
    const home = await realpath(homedir()).catch(() => homedir());
    if (real === dirname(real) || real === home) {
      throw new ProjectError(
        "directory_not_allowed",
        "boof never initialises the filesystem root or the home directory as a project",
      );
    }
    if (exists) {
      if (!(await isDirectory(real))) {
        throw new ProjectError("not_a_directory", `Not a directory: ${real}`);
      }
      let entries: string[];
      try {
        entries = await readdir(real);
      } catch (err) {
        throw new ProjectError(
          "directory_create_failed",
          `Cannot read directory ${real}: ${errCode(err)}`,
        );
      }
      if (entries.some((e) => e !== ".git") && !opts.confirm) {
        throw new ProjectError(
          "directory_not_empty",
          `Directory is not empty: ${real} (pass confirm to initialise it anyway)`,
        );
      }
    } else {
      // access() said "absent", but a dangling symlink or an unreadable entry says that too.
      // Walk up to the first entry that really exists; any entry lstat can see on the way is not absent.
      for (let p = real; !(await isDirectory(p)); p = dirname(p)) {
        try {
          await lstat(p);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw new ProjectError("directory_create_failed", `Cannot inspect ${p}: ${errCode(err)}`);
        }
        throw new ProjectError(
          "directory_create_failed",
          `Cannot create ${real}: ${p} exists but is not a usable directory (dangling symlink?)`,
        );
      }
    }
    let created = false;
    if (!exists) {
      try {
        await mkdir(real, { recursive: true });
      } catch (err) {
        throw new ProjectError(
          "directory_create_failed",
          `Cannot create directory ${real}: ${errCode(err)}`,
        );
      }
      created = true;
    }
    try {
      await this.initGitRepo?.(real);
    } catch (err) {
      if (created) await rm(real, { recursive: true, force: true }).catch(() => undefined);
      throw new ProjectError(
        "directory_create_failed",
        `Cannot initialise a repository in ${real}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { real, created };
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const spec: ProjectPathSpec = input.path ?? { mode: "existing" };
    const existingIds = (await this.list({ includeArchived: true })).map((p) => p.id);
    let id: string | undefined;
    if (input.id !== undefined) {
      id = assertKebabId(input.id);
      if (existingIds.includes(id))
        throw new ProjectError("id_taken", `Project id already exists: ${id}`);
    }
    let target: string;
    if (spec.mode === "auto") {
      if (id === undefined) {
        // A name is occupied when its entry holds something; a missing or empty directory is reusable.
        const occupied: string[] = [];
        for (const e of await readdir(spec.projectsRoot, { withFileTypes: true }).catch(() => [])) {
          const full = join(spec.projectsRoot, e.name);
          const empty = e.isDirectory() && (await readdir(full).catch(() => ["?"])).length === 0;
          if (!empty) occupied.push(e.name);
        }
        id = uniqueKebabId(toKebabId(input.name ?? "") || "project", [...existingIds, ...occupied]);
      }
      target = join(spec.projectsRoot, id);
    } else {
      if (!input.workingDirectory) {
        throw new ProjectError("directory_missing", "workingDirectory is required");
      }
      target = input.workingDirectory;
    }

    let real: string;
    let created = false;
    if (spec.mode === "existing") {
      real = await this.vetDirectory(target);
    } else {
      ({ real, created } = await this.prepareNewDirectory(target, {
        confirm: spec.mode === "new" ? spec.confirm : undefined,
      }));
    }
    try {
      if (spec.mode !== "existing") real = await this.vetDirectory(real);
      id ??= uniqueKebabId(toKebabId(basename(real)) || "project", existingIds);
      const brief = input.brief?.trim();
      const now = nowIso();
      const project = ProjectSchema.parse({
        id,
        name: input.name?.trim() || basename(real) || id,
        workingDirectory: real,
        ...(brief ? { brief } : {}),
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
    } catch (err) {
      if (created) {
        await rm(real, { recursive: true, force: true }).catch(() => undefined);
      }
      throw err;
    }
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
