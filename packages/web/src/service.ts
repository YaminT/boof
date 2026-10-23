import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AttachmentStore,
  CommandStore,
  injectCommand,
  isUserTransition,
  isAllowedAttachmentType,
  MAX_ATTACHMENT_BYTES,
  newTask,
  SettingsStore,
  taskControlDir,
  taskPromptInjectionsPath,
  taskStopRequestPath,
  taskAssetsDir,
  TaskStore,
  uniqueKebabId,
  workingAreaDir,
  type Attachment,
  type Settings,
  type SettingsPatch,
  type Status,
  type Task,
} from "@boof-runner/shared";
import { ToolRegistry, UsageStore, type HealthResult } from "@boof-runner/runner";

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

/**
 * Application service tying the file-backed stores together for the web API.
 * Pure orchestration over shared/runner; no HTTP concerns here so it can be
 * unit-tested directly (web-server spec).
 */
export class TaskService {
  readonly tasks: TaskStore;
  readonly commands: CommandStore;
  readonly settingsStore: SettingsStore;
  readonly attachments: AttachmentStore;
  readonly registry: ToolRegistry;
  private readonly usage: UsageStore;

  constructor(
    readonly root: string,
    registry: ToolRegistry = new ToolRegistry(),
  ) {
    this.tasks = new TaskStore(root);
    this.commands = new CommandStore(root);
    this.settingsStore = new SettingsStore(root);
    this.attachments = new AttachmentStore(root);
    this.registry = registry;
    this.usage = new UsageStore(root);
  }

  list(): Promise<Task[]> {
    return this.tasks.list();
  }

  get(id: string): Promise<Task | null> {
    return this.tasks.get(id);
  }

  async create(input: CreateTaskInput): Promise<Task> {
    const existing = (await this.tasks.list()).map((t) => t.frontmatter.id);
    const id = uniqueKebabId(input.title, existing);
    const status = input.status ?? "draft";
    const task = newTask(
      {
        id,
        title: input.title,
        status,
        priority: input.priority ?? 50,
        skip: false,
        labels: input.labels ?? [],
        command: null,
        attachments: [],
        questions: "none",
        runs: Math.max(1, Math.floor(input.runs ?? 1)),
        completedRuns: 0,
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
    const tpl = await this.commands.get(commandId);
    injectCommand(task, tpl ?? null);
  }

  /** Update task fields in place; transition if `status` changes. */
  async update(id: string, input: UpdateTaskInput): Promise<Task> {
    const task = await this.tasks.get(id);
    if (!task) throw new ServiceError(404, `Task not found: ${id}`);

    if (input.title !== undefined) task.frontmatter.title = input.title;
    if (input.prompt !== undefined) task.body.prompt = input.prompt;
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

  async retry(id: string): Promise<Task> {
    return this.tasks.transition(id, "pending");
  }

  /** Archive a task (any non-running status → archived). */
  async archive(id: string): Promise<Task> {
    return this.tasks.transition(id, "archived");
  }

  /** Unarchive a task back into the pending queue. */
  async unarchive(id: string): Promise<Task> {
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
  async submitAnswers(id: string, answers: string): Promise<Task> {
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

  // --- Commands ---

  listCommands() {
    return this.commands.list();
  }

  async upsertCommand(name: string, body: string) {
    return this.commands.upsert(name, body);
  }

  /**
   * Rename-and-relink: if the new name yields a different id, repoint every
   * referencing task and remove the old template (command-templates spec).
   */
  async renameCommand(oldId: string, name: string, body: string) {
    const tpl = await this.commands.upsert(name, body);
    if (tpl.id !== oldId) {
      const tasks = await this.tasks.list();
      for (const t of tasks) {
        if (t.frontmatter.command === oldId) {
          t.frontmatter.command = tpl.id;
          t.body.command = body;
          await this.tasks.save(t);
        }
      }
      await this.commands.delete(oldId);
    }
    return tpl;
  }

  async deleteCommand(id: string): Promise<{ referencedBy: string[] }> {
    const tasks = await this.tasks.list();
    const referencedBy = tasks
      .filter((t) => t.frontmatter.command === id)
      .map((t) => t.frontmatter.id);
    await this.commands.delete(id);
    return { referencedBy };
  }

  // --- Settings / health / usage ---

  loadSettings(): Promise<Settings> {
    return this.settingsStore.load();
  }

  updateSettings(patch: SettingsPatch): Promise<Settings> {
    return this.settingsStore.update(patch);
  }

  health(): Promise<Record<string, HealthResult>> {
    return this.registry.healthAll();
  }

  listModels(): Promise<Record<string, string[]>> {
    return this.registry.modelsAll();
  }

  loadUsage() {
    return this.usage.load();
  }
}

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
