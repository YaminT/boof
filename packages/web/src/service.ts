import { appendFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  AttachmentStore,
  assertKebabId,
  CommandStore,
  injectCommand,
  isUserTransition,
  isAllowedAttachmentType,
  hasScope,
  MAX_ATTACHMENT_BYTES,
  newTask,
  ProjectError,
  ProjectStore,
  SettingsStore,
  securitySettings,
  taskControlDir,
  taskPromptInjectionsPath,
  taskStopRequestPath,
  taskAssetsDir,
  TaskStore,
  uniqueKebabId,
  workingAreaDir,
  type Attachment,
  type CreateProjectInput,
  type Project,
  type ProjectPatch,
  type TokenUsage,
  type Principal,
  type TaskOrigin,
  type Settings,
  type SettingsPatch,
  type Status,
  type Task,
} from "@boof-runner/shared";
import { PlanService } from "./plans.js";
import {
  isGitRepo,
  sumUsage,
  ToolRegistry,
  UNKNOWN_USAGE,
  UsageStore,
  type HealthResult,
} from "@boof-runner/runner";

export interface CreateTaskInput {
  title: string;
  prompt?: string;
  priority?: number;
  labels?: string[];
  command?: string | null;
  status?: "draft" | "pending";
  /** How many times to run the pipeline for this task (default 1). */
  runs?: number;
}

export interface UpdateTaskInput {
  title?: string;
  prompt?: string;
  priority?: number;
  labels?: string[];
  command?: string | null;
  skip?: boolean;
  /** Update how many times to run the pipeline (clamped to >= 1). */
  runs?: number;
  /** If set and different from the current status, a transition is attempted. */
  status?: Status;
}

/** A task as sent over the API: the task file plus the project it lives in. */
export type TaskView = Task & { projectId: string };

export function toTaskView(projectId: string, task: Task): TaskView {
  return { ...task, projectId };
}

/**
 * Task operations for ONE project (projects/<id>/). Holds that project's stores; the
 * command templates and settings are global and reached through the parent service.
 * Pure orchestration over shared/runner; no HTTP concerns here (web-server spec).
 */
export class ProjectService {
  readonly tasks: TaskStore;
  readonly attachments: AttachmentStore;
  /** The plans of this project (plan model). */
  readonly plans: PlanService;
  private readonly usage: UsageStore;
  /** The project directory: the `root` of this project's stores. */
  readonly root: string;

  constructor(
    private readonly parent: TaskService,
    readonly projectId: string,
  ) {
    this.root = parent.projects.dir(projectId);
    this.tasks = new TaskStore(this.root);
    this.attachments = new AttachmentStore(this.root);
    this.usage = new UsageStore(this.root);
    this.plans = new PlanService(parent, projectId, this.root);
  }

  list(): Promise<Task[]> {
    return this.tasks.list();
  }

  get(id: string): Promise<Task | null> {
    return this.tasks.get(id);
  }

  /** True when `actor` is a review-trust client and approval is required (the default). */
  private async needsApproval(actor?: Principal): Promise<boolean> {
    if (!actor || actor.kind !== "client" || actor.trust !== "review") return false;
    return securitySettings(await this.parent.loadSettings()).externalTasksRequireApproval;
  }

  /** A review-trust client may not move work into the queue; a human or trusted principal does. */
  private async assertMayQueue(actor?: Principal): Promise<void> {
    if (await this.needsApproval(actor)) {
      throw new ServiceError(
        403,
        "This client has review trust and cannot queue tasks; a human must approve them",
        "forbidden_trust",
      );
    }
  }

  async create(input: CreateTaskInput, actor?: Principal): Promise<Task> {
    const existing = (await this.tasks.list()).map((t) => t.frontmatter.id);
    const id = uniqueKebabId(input.title, existing);
    const review = await this.needsApproval(actor);
    const status = review ? "draft" : (input.status ?? "draft");
    const labels = [...(input.labels ?? [])];
    if (review && actor) labels.push(`external:${actor.id}`);
    const origin: TaskOrigin | undefined =
      actor?.kind === "client"
        ? { kind: ORIGIN_KIND[actor.clientKind ?? "harness"], client: actor.id }
        : undefined;
    const task = newTask(
      {
        id,
        title: input.title,
        status,
        priority: input.priority ?? 50,
        skip: false,
        labels,
        command: null,
        attachments: [],
        questions: "none",
        runs: Math.max(1, Math.floor(input.runs ?? 1)),
        completedRuns: 0,
        ...(origin ? { origin } : {}),
        created: "",
        updated: "",
      },
      input.prompt ?? "",
    );
    if (input.command) await this.applyCommand(task, input.command);
    return this.tasks.create(task);
  }

  private async applyCommand(task: Task, commandId: string | null): Promise<void> {
    if (!commandId) {
      injectCommand(task, null);
      return;
    }
    const tpl = await this.parent.commands.get(commandId);
    injectCommand(task, tpl ?? null);
  }

  /** Update task fields in place; transition if `status` changes. */
  async update(id: string, input: UpdateTaskInput, actor?: Principal): Promise<Task> {
    if (input.status === "pending") await this.assertMayQueue(actor);
    const task = await this.tasks.get(id);
    if (!task) throw new ServiceError(404, `Task not found: ${id}`);

    if (input.title !== undefined) task.frontmatter.title = input.title;
    if (input.prompt !== undefined) {
      // A hand edit of a plan task: plan sync must append changes instead of overwriting it.
      if (task.frontmatter.planRef && input.prompt !== task.body.prompt) {
        task.frontmatter.promptSource = "manual";
      }
      task.body.prompt = input.prompt;
    }
    if (input.priority !== undefined) task.frontmatter.priority = input.priority;
    if (input.labels !== undefined) task.frontmatter.labels = input.labels;
    if (input.skip !== undefined) task.frontmatter.skip = input.skip;
    if (input.runs !== undefined) task.frontmatter.runs = Math.max(1, Math.floor(input.runs));
    if (input.command !== undefined) await this.applyCommand(task, input.command);

    const targetStatus = input.status;
    if (targetStatus && targetStatus !== task.frontmatter.status) {
      const from = task.frontmatter.status;
      if (!isUserTransition(from, targetStatus)) {
        throw new ServiceError(
          409,
          `Invalid status transition: ${from} → ${targetStatus}`,
          "invalid_transition",
        );
      }
      // Persist field edits first, then transition (which re-reads + moves).
      await this.tasks.save(task);
      return this.tasks.transition(id, targetStatus);
    }
    return this.tasks.save(task);
  }

  setSkip(id: string, skip: boolean): Promise<Task> {
    return this.tasks.setSkip(id, skip);
  }

  /**
   * Reorder by a list of ids (first = highest priority). Rewrites priority on
   * each listed task with gaps so later single-item drags stay stable.
   */
  async reorder(orderedIds: string[]): Promise<Task[]> {
    const n = orderedIds.length;
    const out: Task[] = [];
    for (let i = 0; i < n; i += 1) {
      const task = await this.tasks.get(orderedIds[i]);
      if (!task) continue;
      task.frontmatter.priority = (n - i) * 10;
      out.push(await this.tasks.save(task));
    }
    return out;
  }

  async retry(id: string, actor?: Principal): Promise<Task> {
    await this.assertMayQueue(actor);
    return this.tasks.transition(id, "pending");
  }

  /** Archive a task (any non-running status → archived). */
  async archive(id: string): Promise<Task> {
    return this.tasks.transition(id, "archived");
  }

  /** Unarchive a task back into the pending queue. */
  async unarchive(id: string, actor?: Principal): Promise<Task> {
    await this.assertMayQueue(actor);
    return this.tasks.transition(id, "pending");
  }

  /**
   * Permanently delete a task and its attachments. A running task must finish
   * (or be archived) first — deleting mid-run would orphan the agent process.
   */
  async deleteTask(id: string): Promise<{ ok: true }> {
    const task = await this.tasks.get(id);
    if (!task) throw new ServiceError(404, `Task not found: ${id}`);
    if (task.frontmatter.status === "running") {
      throw new ServiceError(400, "Cannot delete a running task; wait for it to finish first");
    }
    await this.tasks.delete(id);
    await rm(taskAssetsDir(this.root, id), { recursive: true, force: true }).catch(() => {});
    return { ok: true };
  }

  /**
   * Live agent output for a task. While running, reads the streaming log.txt in
   * the working area (updated chunk-by-chunk as the tool emits output); once the
   * task leaves `running`, falls back to the durable body log (the working area
   * is removed on completion). `running` lets the UI keep polling while true.
   */
  async liveLog(id: string): Promise<{ log: string; running: boolean }> {
    const task = await this.tasks.get(id);
    if (!task) throw new ServiceError(404, `Task not found: ${id}`);
    const running = task.frontmatter.status === "running";
    if (!running) return { log: task.body.log, running };
    const path = join(workingAreaDir(this.root, id), "log.txt");
    const log = await readFile(path, "utf8").catch(() => task.body.log);
    return { log, running };
  }

  async stopTask(id: string): Promise<{ ok: true }> {
    const task = await this.tasks.get(id);
    if (!task) throw new ServiceError(404, `Task not found: ${id}`);
    if (task.frontmatter.status !== "running") {
      throw new ServiceError(400, "Task is not running");
    }
    await mkdir(taskControlDir(this.root, id), { recursive: true });
    await writeFile(taskStopRequestPath(this.root, id), new Date().toISOString() + "\n", "utf8");
    await appendFile(
      join(workingAreaDir(this.root, id), "log.txt"),
      `\n\n### Stop requested\n${new Date().toISOString()}\n`,
      "utf8",
    ).catch(() => {});
    return { ok: true };
  }

  async injectPrompt(id: string, prompt: string): Promise<{ ok: true }> {
    const text = prompt.trim();
    if (!text) throw new ServiceError(400, "Prompt is required");
    const task = await this.tasks.get(id);
    if (!task) throw new ServiceError(404, `Task not found: ${id}`);
    if (task.frontmatter.status !== "running") {
      throw new ServiceError(400, "Task is not running");
    }

    const now = new Date().toISOString();
    await mkdir(taskControlDir(this.root, id), { recursive: true });
    await appendFile(taskPromptInjectionsPath(this.root, id), `\n\n## ${now}\n${text}\n`, "utf8");
    await appendFile(
      join(workingAreaDir(this.root, id), "log.txt"),
      `\n\n### Injected prompt\n${text}\n`,
      "utf8",
    ).catch(() => {});
    return { ok: true };
  }

  /** Submit answers for a parked task: write answers, mark answered, resume. */
  async submitAnswers(id: string, answers: string, actor?: Principal): Promise<Task> {
    await this.assertMayQueue(actor);
    return this.tasks.transition(id, "pending", (t) => {
      t.body.answers = answers;
      t.frontmatter.questions = "answered";
    });
  }

  // --- Attachments ---

  /**
   * Store an uploaded image/PDF for a task and record it in the frontmatter.
   * Rejects disallowed types or oversized files before touching disk.
   */
  async addAttachment(
    id: string,
    filename: string,
    type: string,
    bytes: Uint8Array,
  ): Promise<Task> {
    const task = await this.tasks.get(id);
    if (!task) throw new ServiceError(404, `Task not found: ${id}`);
    if (!isAllowedAttachmentType(type)) {
      throw new ServiceError(400, `Unsupported attachment type: ${type || "unknown"}`);
    }
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new ServiceError(400, "Attachment exceeds the 25 MB limit");
    }
    const name = await this.attachments.write(id, filename, bytes);
    const entry: Attachment = { name, type, size: bytes.byteLength };
    task.frontmatter.attachments = [
      ...task.frontmatter.attachments.filter((a) => a.name !== name),
      entry,
    ];
    return this.tasks.save(task);
  }

  /** Remove an attachment's file and frontmatter entry. */
  async removeAttachment(id: string, name: string): Promise<Task> {
    const task = await this.tasks.get(id);
    if (!task) throw new ServiceError(404, `Task not found: ${id}`);
    await this.attachments.remove(id, name);
    task.frontmatter.attachments = task.frontmatter.attachments.filter((a) => a.name !== name);
    return this.tasks.save(task);
  }

  /** Read an attachment's bytes + its recorded MIME type for serving. */
  async getAttachment(id: string, name: string): Promise<{ bytes: Buffer; type: string }> {
    const task = await this.tasks.get(id);
    if (!task) throw new ServiceError(404, `Task not found: ${id}`);
    const meta = task.frontmatter.attachments.find((a) => a.name === name);
    if (!meta) throw new ServiceError(404, `Attachment not found: ${name}`);
    try {
      const bytes = await this.attachments.read(id, name);
      return { bytes, type: meta.type };
    } catch {
      throw new ServiceError(404, `Attachment file missing: ${name}`);
    }
  }

  loadUsage(): Promise<TokenUsage> {
    return this.usage.load();
  }
}

/**
 * Application facade: the project registry plus the global parts (commands, settings, tool
 * registry). Task operations live on {@link ProjectService}, one per project (cached).
 */
export class TaskService {
  readonly projects: ProjectStore;
  readonly commands: CommandStore;
  readonly settingsStore: SettingsStore;
  readonly registry: ToolRegistry;
  private readonly cache = new Map<string, ProjectService>();

  constructor(
    readonly root: string,
    registry: ToolRegistry = new ToolRegistry(),
  ) {
    this.projects = new ProjectStore(root, { isGitRepo });
    this.commands = new CommandStore(root);
    this.settingsStore = new SettingsStore(root);
    this.registry = registry;
  }

  /** The (cached) service of project `id`. Does not check that the project exists. */
  forProject(id: string): ProjectService {
    let svc = this.cache.get(id);
    if (!svc) {
      svc = new ProjectService(this, assertKebabId(id));
      this.cache.set(id, svc);
    }
    return svc;
  }

  /** Like {@link forProject} but throws 404 `project_not_found` for an unknown project. */
  async requireProject(id: string): Promise<ProjectService> {
    if (!(await this.projects.get(id))) throw projectNotFound(id);
    return this.forProject(id);
  }

  // --- Projects ---

  listProjects(opts: { includeArchived?: boolean } = {}): Promise<Project[]> {
    return this.projects.list(opts);
  }

  async getProject(id: string): Promise<Project> {
    const project = await this.projects.get(id);
    if (!project) throw projectNotFound(id);
    return project;
  }

  /**
   * Register a project. A non-local principal may only register a git work tree whose
   * realpath is under `security.allowedProjectRoots` (and never `/`, the home directory or
   * the data root): otherwise 403 `project_root_not_allowed`.
   */
  async createProject(input: CreateProjectInput, actor?: Principal): Promise<Project> {
    if (actor && actor.kind !== "local")
      await this.assertRegistrationAllowed(actor, input.workingDirectory);
    try {
      return await this.projects.create({
        ...input,
        origin:
          input.origin ??
          (actor?.kind === "client" ? { kind: "api", client: actor.id } : { kind: "ui" }),
      });
    } catch (err) {
      throw this.mapProjectError(err, actor);
    }
  }

  async updateProject(id: string, patch: ProjectPatch, actor?: Principal): Promise<Project> {
    if (patch.workingDirectory !== undefined && actor && actor.kind !== "local") {
      await this.assertRegistrationAllowed(actor, patch.workingDirectory);
    }
    try {
      return await this.projects.update(id, patch);
    } catch (err) {
      throw this.mapProjectError(err, actor);
    }
  }

  archiveProject(id: string): Promise<Project> {
    return this.updateProject(id, { archived: true });
  }

  unarchiveProject(id: string): Promise<Project> {
    return this.updateProject(id, { archived: false });
  }

  pauseProject(id: string): Promise<Project> {
    return this.updateProject(id, { paused: true });
  }

  resumeProject(id: string): Promise<Project> {
    return this.updateProject(id, { paused: false });
  }

  /** Archive (default) or purge a project; refused while one of its tasks runs. */
  async removeProject(id: string, opts: { purge?: boolean } = {}): Promise<{ ok: true }> {
    try {
      await this.projects.remove(id, opts);
    } catch (err) {
      throw this.mapProjectError(err);
    }
    if (opts.purge) {
      this.cache.delete(id);
      const settings = await this.loadSettings();
      if (settings.defaultProject === id) await this.settingsStore.update({ defaultProject: null });
    }
    return { ok: true };
  }

  private mapProjectError(err: unknown, actor?: Principal): unknown {
    if (!(err instanceof ProjectError)) return err;
    const remote = actor !== undefined && actor.kind !== "local";
    switch (err.code) {
      case "not_found":
        return new ServiceError(404, err.message, "project_not_found");
      case "id_taken":
      case "duplicate":
        return new ServiceError(
          409,
          err.message,
          err.code === "duplicate" ? "project_exists" : "conflict",
        );
      case "has_running_task":
        return new ServiceError(409, err.message, "project_busy");
      case "not_git_repo":
      case "inside_data_root":
        return remote
          ? new ServiceError(403, err.message, "project_root_not_allowed")
          : new ServiceError(
              400,
              err.message,
              err.code === "not_git_repo" ? "not_a_git_repo" : "invalid_input",
            );
      default:
        return new ServiceError(400, err.message, "invalid_input");
    }
  }

  private async assertRegistrationAllowed(actor: Principal, dir: string): Promise<void> {
    const { allowedProjectRoots } = securitySettings(await this.loadSettings());
    const deny = (why: string): ServiceError =>
      new ServiceError(
        403,
        `Project root not allowed: ${why}`,
        "project_root_not_allowed",
        hasScope(actor, "admin") ? { allowedRoots: allowedProjectRoots } : undefined,
      );
    if (allowedProjectRoots.length === 0) throw deny("no allowedProjectRoots are configured");
    let real: string;
    try {
      real = await realpath(dir);
    } catch {
      throw new ServiceError(400, `Directory does not exist: ${dir}`, "invalid_input");
    }
    if (real === resolve("/") || real === (await realpath(homedir()).catch(() => homedir()))) {
      throw deny("the filesystem root and the home directory cannot be projects");
    }
    const roots = await Promise.all(
      allowedProjectRoots.map(async (r) => {
        const expanded =
          r === "~" ? homedir() : r.startsWith("~/") ? join(homedir(), r.slice(2)) : r;
        return realpath(expanded).catch(() => null);
      }),
    );
    const inside = roots.some((r) => {
      if (!r) return false;
      const rel = relative(r, real);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
    if (!inside) throw deny("outside the allowed project roots");
    // Git work tree and data-root checks happen in ProjectStore (mapped to the same code).
  }

  // --- Aggregates ---

  /** Usage of one project. */
  async projectUsage(id: string): Promise<TokenUsage> {
    await this.getProject(id);
    return this.forProject(id).loadUsage();
  }

  /** Sum of the usage of every project `allowed` accepts (archived ones included). */
  async totalUsage(allowed: (projectId: string) => boolean = () => true): Promise<TokenUsage> {
    const all = await this.projects.list({ includeArchived: true });
    const usages: TokenUsage[] = [];
    for (const p of all) if (allowed(p.id)) usages.push(await this.forProject(p.id).loadUsage());
    return usages.length ? sumUsage(usages) : { ...UNKNOWN_USAGE };
  }

  /** Tasks parked in `action` across the projects `allowed` accepts (non-archived projects). */
  async listActions(allowed: (projectId: string) => boolean = () => true): Promise<TaskView[]> {
    const out: TaskView[] = [];
    for (const p of await this.projects.list()) {
      if (!allowed(p.id)) continue;
      for (const t of await this.forProject(p.id).tasks.list()) {
        if (t.frontmatter.status === "action") out.push(toTaskView(p.id, t));
      }
    }
    return out;
  }

  // --- Commands (global templates) ---

  listCommands() {
    return this.commands.list();
  }

  async upsertCommand(name: string, body: string) {
    return this.commands.upsert(name, body);
  }

  /**
   * Rename-and-relink: if the new name yields a different id, repoint every
   * referencing task in every project and remove the old template (command-templates spec).
   */
  async renameCommand(oldId: string, name: string, body: string) {
    const tpl = await this.commands.upsert(name, body);
    if (tpl.id !== oldId) {
      for (const p of await this.projects.list({ includeArchived: true })) {
        const store = this.forProject(p.id).tasks;
        for (const t of await store.list()) {
          if (t.frontmatter.command === oldId) {
            t.frontmatter.command = tpl.id;
            t.body.command = body;
            await store.save(t);
          }
        }
      }
      await this.commands.delete(oldId);
    }
    return tpl;
  }

  async deleteCommand(id: string): Promise<{ referencedBy: string[] }> {
    const referencedBy: string[] = [];
    for (const p of await this.projects.list({ includeArchived: true })) {
      for (const t of await this.forProject(p.id).tasks.list()) {
        if (t.frontmatter.command === id) referencedBy.push(t.frontmatter.id);
      }
    }
    await this.commands.delete(id);
    return { referencedBy };
  }

  // --- Settings / health ---

  loadSettings(): Promise<Settings> {
    return this.settingsStore.load();
  }

  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    if (patch.defaultProject) await this.getProject(patch.defaultProject);
    return this.settingsStore.update(patch);
  }

  health(): Promise<Record<string, HealthResult>> {
    return this.registry.healthAll();
  }

  listModels(): Promise<Record<string, string[]>> {
    return this.registry.modelsAll();
  }
}

function projectNotFound(id: string): ServiceError {
  return new ServiceError(404, `Project not found: ${id}`, "project_not_found");
}

const ORIGIN_KIND = { harness: "api", mcp: "mcp", ui: "ui", cli: "cli" } as const;

function defaultCodeFor(status: number): string {
  if (status === 400) return "invalid_input";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  return "error";
}

export class ServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = defaultCodeFor(status),
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
