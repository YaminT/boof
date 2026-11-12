import { createHash } from "node:crypto";
import {
  ABSENT_POOL,
  OwlishClient,
  OwlishError,
  OwlishSecretStore,
  type AdminRouteProbe,
  ProjectKeyStore,
  decideAgentAuth,
  withAgentKey,
  agentAuthRefusalMessage,
  agentKeyIsSeparate,
  type AgentSdkEligibility,
  type PoolStatus,
} from "@boof/owlish";
import { appendFile, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  agentStatus,
  AuthStore,
  appendEvent,
  AttachmentStore,
  evaluateBudget,
  type BudgetStatus,
  assertKebabId,
  buildHierarchyIndex,
  clearMissingCommand,
  CommandStore,
  auditOperation,
  createTaskInHierarchy,
  moveTask as moveTaskInHierarchy,
  removeTask,
  type MoveInput,
  EpicStore,
  removeEpic,
  type CreateEpicInput,
  type Epic,
  type EpicPatch,
  type HierarchyIndex,
  injectCommand,
  isUserTransition,
  isAllowedAttachmentType,
  hasScope,
  MAX_ATTACHMENT_BYTES,
  newTask,
  ProjectError,
  ProjectStore,
  expandHome,
  isInsidePath,
  resolveProjectsRoot,
  resolveUnbornPath,
  SettingsStore,
  securitySettings,
  taskPromptInjectionsPath,
  taskSteerRequestPath,
  taskAssetsDir,
  TaskStore,
  appendInjectedEntry,
  workingAreaDir,
  type Attachment,
  type InjectMode,
  type Project,
  type ProjectOrigin,
  type ProjectPatch,
  type TokenUsage,
  type Principal,
  type TaskOrigin,
  type Settings,
  type SettingsPatch,
  effectiveSettings,
  resolveWorktreeRoot,
  worktreeSettings,
  type Status,
  type Task,
  taskReviewInfo,
  type TaskReviewInfo,
  appendAnswerRound,
  WebhookSecretStore,
  N8nSecretStore,
  atomicWrite,
  checkProfiles,
  settingsVersion,
  initGitRepo,
  isGitRepo,
  pruneStaleWorktrees,
  repoCommonDir,
  taskDiff,
  BranchNotFoundError,
  InvalidDiffPathError,
  sumUsage,
  UNKNOWN_USAGE,
  UsageStore,
  type TaskDiff,
  type CachedHealth,
  type HealthResult,
  type InstallResult,
  type ToolCatalog,
} from "@boof/heart";
import { checkedWorktreeGit, loadWorktreeRecord } from "@boof/runner";
import { OpError } from "../errors.js";
import type { CreateProjectBodyInput } from "../validation.js";
import { statusDowngraded, subtasksOpen, type Warning } from "../warnings.js";
import { PlanService } from "./plan-service.js";
import type { ConciergeService } from "../../concierge/service.js";
import type { ConciergeAgent } from "@boof/heart";
import { cleanN8nName } from "../../n8n/text.js";

export interface CreateTaskInput {
  title: string;
  prompt?: string;
  priority?: number;
  labels?: string[];
  command?: string | null;
  status?: "draft" | "pending";
  /** How many times to run the pipeline for this task (default 1). */
  runs?: number;
  /** The task's epic, or (parentId) its parent task. Not both. */
  epicId?: string;
  parentId?: string;
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
  /** The task's `updated` timestamp the caller last saw (HTTP If-Match); a newer one is a 409. */
  expectedUpdated?: string;
}

/** An epic as sent over the API: the record plus its derived progress. */
export type EpicView = Epic & { progress: { total: number; done: number } };

/** A task as sent over the API: the task file plus the project it lives in. */
export type TaskView = Omit<Task, "body"> & {
  body: Omit<Task["body"], "log"> & { log?: string };
  projectId: string;
} & TaskReviewInfo;

/**
 * The task as the API shows it. `log` (the raw agent output, often megabytes) is left out
 * unless asked for.
 */
export function toTaskView(projectId: string, task: Task, opts: { log?: boolean } = {}): TaskView {
  const info = taskReviewInfo(task);
  if (opts.log === false) {
    const { log: _log, ...body } = task.body;
    return { ...task, body, projectId, ...info };
  }
  return { ...task, projectId, ...info };
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

  /** Status counts and the running ids. Does not read task bodies. */
  statusSummary() {
    return this.tasks.statusSummary();
  }

  get(id: string): Promise<Task | null> {
    return this.tasks.get(id);
  }

  /** The hierarchy of the project's tasks (pass the list you already read to avoid a second scan) and epics (archived epics included), for the derived task fields. */
  async hierarchy(known?: Task[]): Promise<HierarchyIndex> {
    const [tasks, epics] = await Promise.all([
      known ?? this.tasks.list(),
      // A broken epics.json must not take every task read down (the epic operations still fail
      // loudly): without epics, tasks that name one show `epicMissing`.
      new EpicStore(this.root).list({ includeArchived: true }).catch((err) => {
        console.error(`epics of project ${this.projectId} are unreadable:`, err);
        return [];
      }),
    ]);
    return buildHierarchyIndex(tasks, epics);
  }

  /** True when `actor` is a review-trust client and approval is required (the default). */
  private async needsApproval(actor?: Principal): Promise<boolean> {
    if (!actor || actor.kind !== "client" || actor.trust !== "review") return false;
    if (actor.alwaysReview) return true;
    return securitySettings(await this.parent.loadSettings()).externalTasksRequireApproval;
  }

  /** A review-trust client may not move work into the queue; a human or trusted principal does. */
  private async assertMayQueue(actor?: Principal): Promise<void> {
    if (await this.needsApproval(actor)) {
      throw new OpError(
        403,
        "This client has review trust and cannot queue tasks; a human must approve them",
        "forbidden_trust",
      );
    }
  }

  /** A review-trust client may stop or steer only the tasks it created. */
  private async assertMayControl(task: Task, actor?: Principal): Promise<void> {
    if (!(await this.needsApproval(actor))) return;
    if (actor && task.frontmatter.origin?.client === actor.id) return;
    throw new OpError(
      403,
      "This client has review trust and can only stop or steer tasks it created",
      "forbidden_trust",
    );
  }

  // --- Epics ---

  private async epicView(epic: Epic, index?: HierarchyIndex): Promise<EpicView> {
    const idx = index ?? (await this.hierarchy());
    return { ...epic, progress: idx.epicProgress(epic.id) };
  }

  async listEpics(opts: { includeArchived?: boolean } = {}): Promise<EpicView[]> {
    const [epics, index] = await Promise.all([
      new EpicStore(this.root).list(opts),
      this.hierarchy(),
    ]);
    return Promise.all(epics.map((e) => this.epicView(e, index)));
  }

  async getEpic(id: string): Promise<EpicView> {
    return this.epicView(await new EpicStore(this.root).require(id));
  }

  async createEpic(input: CreateEpicInput, actor?: Principal): Promise<EpicView> {
    return this.epicView(
      await new EpicStore(this.root).create(input, {
        by: actor?.id ?? "local",
        origin: originOf(actor),
      }),
    );
  }

  async updateEpic(
    id: string,
    patch: EpicPatch & { expectedUpdated?: string },
    actor?: Principal,
  ): Promise<EpicView> {
    const { expectedUpdated, ...fields } = patch;
    const store = new EpicStore(this.root);
    // A review-trust client changes only the epics it created (its owner never changes). An epic
    // without an origin is a human's.
    if (await this.needsApproval(actor)) {
      const epic = await store.require(id);
      if (epic.origin?.client !== actor?.id) {
        throw new OpError(
          403,
          "This client has review trust and can only change epics it created",
          "forbidden_trust",
        );
      }
    }
    return this.epicView(
      await store.update(id, fields, {
        by: actor?.id ?? "local",
        expectedUpdated,
      }),
    );
  }

  /** Delete an epic; tasks that name it block it unless `detach` clears their epic. */
  async deleteEpic(
    id: string,
    opts: { detach?: boolean } = {},
    actor?: Principal,
  ): Promise<{ ok: true; detached: string[] }> {
    if (await this.needsApproval(actor)) {
      throw new OpError(
        403,
        "This client has review trust and cannot delete epics; archive it or ask the user",
        "forbidden_trust",
      );
    }
    const { detached } = await removeEpic(this.root, id, {
      detach: opts.detach,
      by: actor?.id ?? "local",
    });
    return { ok: true, detached };
  }

  /** A review-trust client may move, edit and delete only the tasks it created. */
  private async assertMayChange(
    task: Task,
    verb: "move" | "edit" | "delete" | "skip" | "reorder",
    actor?: Principal,
  ): Promise<void> {
    if (!(await this.needsApproval(actor))) return;
    if (actor && task.frontmatter.origin?.client === actor.id) return;
    throw new OpError(
      403,
      `This client has review trust and can only ${verb} tasks it created`,
      "forbidden_trust",
    );
  }

  /** A review-trust client may skip and reorder only its own tasks (an unknown id is left to the store). */
  private async assertOwnTask(
    id: string,
    verb: "skip" | "reorder",
    actor?: Principal,
  ): Promise<void> {
    if (!(await this.needsApproval(actor))) return;
    const task = await this.tasks.get(id);
    if (task) await this.assertMayChange(task, verb, actor);
  }

  /** Change a task's epic or parent (null clears). One level of subtasks; a parent clears the epic. */
  async moveTask(id: string, input: MoveInput, actor?: Principal): Promise<Task> {
    const given = [input.epicId, input.parentId].filter((v) => v !== undefined);
    if (
      given.length === 0 ||
      (typeof input.epicId === "string" && typeof input.parentId === "string")
    ) {
      throw new OpError(400, "Invalid input", "invalid_input", [
        {
          path: "parentId",
          message: "give epicId or parentId (a subtask takes its parent's epic), null clears",
        },
      ]);
    }
    const task = await this.tasks.get(id);
    if (!task) throw new OpError(404, `Task not found: ${id}`);
    await this.assertMayChange(task, "move", actor);
    return moveTaskInHierarchy(this.root, id, input, { by: actor?.id ?? "local" });
  }

  async create(input: CreateTaskInput, actor?: Principal): Promise<Task> {
    return (await this.createWithWarnings(input, actor)).task;
  }

  /** Like {@link create}, plus a `status_downgraded` warning when a review client asked for `pending`. */
  async createWithWarnings(
    input: CreateTaskInput,
    actor?: Principal,
  ): Promise<{ task: Task; warnings: Warning[] }> {
    const id = "pending-id";
    const review = await this.needsApproval(actor);
    const status = review ? "draft" : (input.status ?? "draft");
    const labels = [...(input.labels ?? [])];
    if (review && actor) labels.push(`external:${actor.id}`);
    const origin = originOf(actor);
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
        ...(input.epicId ? { epicId: input.epicId } : {}),
        ...(input.parentId ? { parentId: input.parentId } : {}),
        created: "",
        updated: "",
      },
      input.prompt ?? "",
    );
    if (input.command) await this.applyCommand(task, input.command);
    const warnings =
      review && input.status && input.status !== status
        ? [statusDowngraded("task", input.status, status)]
        : [];
    if (input.epicId && input.parentId) {
      throw new OpError(400, "Invalid input", "invalid_input", [
        {
          path: "parentId",
          message: "give epicId or parentId, not both: a subtask takes its parent's epic",
        },
      ]);
    }
    return {
      task: await createTaskInHierarchy(this.root, task, { by: actor?.id ?? "local" }),
      warnings,
    };
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
    return (await this.updateWithWarnings(id, input, actor)).task;
  }

  /** Like {@link update}, plus a `subtasks_open` warning when a parent is queued with open subtasks. */
  async updateWithWarnings(
    id: string,
    input: UpdateTaskInput,
    actor?: Principal,
  ): Promise<{ task: Task; warnings: Warning[]; index?: HierarchyIndex }> {
    if (input.status === "pending") await this.assertMayQueue(actor);
    const review = await this.needsApproval(actor);
    const tpl = input.command ? await this.parent.commands.get(input.command) : null;

    let from: Task["frontmatter"]["status"] | undefined;
    const task = await this.tasks.modify(id, (task) => {
      if (
        input.expectedUpdated !== undefined &&
        input.expectedUpdated !== task.frontmatter.updated
      ) {
        throw new OpError(409, "The task was changed by someone else", "task_modified", {
          currentUpdated: task.frontmatter.updated,
          expectedUpdated: input.expectedUpdated,
        });
      }

      // A review client may change only the tasks it created ...
      if (review && task.frontmatter.origin?.client !== actor?.id) {
        throw new OpError(
          403,
          "This client has review trust and can only edit tasks it created",
          "forbidden_trust",
        );
      }
      // ... and shape its own drafts, but not rewrite work a human already released.
      if (
        task.frontmatter.status !== "draft" &&
        (input.title !== undefined ||
          input.prompt !== undefined ||
          input.command !== undefined ||
          input.runs !== undefined) &&
        review
      ) {
        throw new OpError(
          403,
          "This client has review trust and cannot change the title or prompt of a task that is not a draft",
          "forbidden_trust",
        );
      }

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
      if (input.command !== undefined) injectCommand(task, input.command ? (tpl ?? null) : null);

      from = task.frontmatter.status;
      if (input.status && input.status !== from && !isUserTransition(from, input.status)) {
        throw new OpError(
          409,
          `Invalid status transition: ${from} → ${input.status}`,
          "invalid_transition",
        );
      }
    });
    if (input.status && input.status !== from) {
      if (input.status === "pending") await this.assertNoLiveAgent(id);
      const moved = await this.tasks.transition(
        id,
        input.status,
        input.status === "pending"
          ? (t) => {
              delete t.frontmatter.agentProcess;
            }
          : undefined,
        { by: actor?.id ?? "local" },
      );
      const warnings: Warning[] = [];
      let index: HierarchyIndex | undefined;
      if (input.status === "pending") {
        index = await this.hierarchy();
        const sub = index.info(moved).subtasks;
        if (sub && sub.done < sub.total) {
          warnings.push(subtasksOpen(id, sub.total - sub.done, sub.total));
        }
      }
      return { task: moved, warnings, index };
    }
    return { task, warnings: [] };
  }

  async setSkip(id: string, skip: boolean, actor?: Principal): Promise<Task> {
    await this.assertOwnTask(id, "skip", actor);
    return this.tasks.setSkip(id, skip);
  }

  /**
   * Reorder by a list of ids (first = highest priority). Rewrites priority on
   * each listed task with gaps so later single-item drags stay stable.
   */
  async reorder(orderedIds: string[], actor?: Principal): Promise<Task[]> {
    for (const id of orderedIds) await this.assertOwnTask(id, "reorder", actor);
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
    return this.requeue(id, actor);
  }

  /**
   * Refuse to queue a task whose interrupted run left an agent process that is still alive (the
   * identity recovery stored in `agentProcess`): a second agent would work in the same worktree.
   * A process that is gone, another process under a reused pid, or one that cannot be verified does
   * not block.
   */
  private async assertNoLiveAgent(id: string, action: "retry" | "delete" = "retry"): Promise<void> {
    const agent = (await this.tasks.get(id))?.frontmatter.agentProcess;
    if (agent && agentStatus(agent) === "running") {
      throw new OpError(
        409,
        `The agent process of the interrupted run (pid ${agent.pgid}${agent.command ? `, ${agent.command}` : ""}) is still running; stop it before you ${action}, or a second agent will work in the same worktree`,
        "conflict",
      );
    }
  }

  /** Move a task to pending; its command id is dropped when that template is gone. */
  private async requeue(id: string, actor?: Principal): Promise<Task> {
    await this.assertNoLiveAgent(id);
    const task = await this.tasks.transition(
      id,
      "pending",
      (t) => {
        delete t.frontmatter.agentProcess; // gone or not ours: nothing to remember
      },
      { by: actor?.id ?? "local" },
    );
    await clearMissingCommand(this.parent.commands, this.tasks, id);
    return (await this.tasks.get(id)) ?? task;
  }

  /** Archive a task (any non-running status → archived). */
  async archive(id: string, actor?: Principal): Promise<Task> {
    return this.tasks.transition(id, "archived", undefined, { by: actor?.id ?? "local" });
  }

  /** Unarchive a task back into the pending queue. */
  async unarchive(id: string, actor?: Principal): Promise<Task> {
    await this.assertMayQueue(actor);
    return this.requeue(id, actor);
  }

  /**
   * Permanently delete a task and its attachments. A running task must finish
   * (or be archived) first — deleting mid-run would orphan the agent process.
   */
  async deleteTask(
    id: string,
    opts: { detach?: boolean } = {},
    actor?: Principal,
  ): Promise<{ ok: true; detached: string[] }> {
    if (opts.detach && (await this.needsApproval(actor))) {
      throw new OpError(
        403,
        "This client has review trust and cannot detach subtasks; a human must approve this",
        "forbidden_trust",
      );
    }
    const task = await this.tasks.get(id);
    if (!task) throw new OpError(404, `Task not found: ${id}`);
    await this.assertMayChange(task, "delete", actor);
    if (task.frontmatter.status === "running") {
      throw new OpError(400, "Cannot delete a running task; wait for it to finish first");
    }
    // A new task with this id would share the worktree an orphaned agent may still be working in.
    await this.assertNoLiveAgent(id, "delete");
    const { detached } = await removeTask(this.root, id, {
      detach: opts.detach,
      by: actor?.id ?? "local",
    });
    await rm(taskAssetsDir(this.root, id), { recursive: true, force: true }).catch(() => {});
    return { ok: true, detached };
  }

  /**
   * Live agent output for a task. While running, reads the streaming log.txt in
   * the working area (updated chunk-by-chunk as the tool emits output); once the
   * task leaves `running`, falls back to the durable body log (the working area
   * is removed on completion). `running` lets the UI keep polling while true.
   */
  async liveLog(
    id: string,
    opts: { tail?: number } = {},
  ): Promise<{ log: string; running: boolean }> {
    const task = await this.tasks.get(id);
    if (!task) throw new OpError(404, `Task not found: ${id}`);
    const running = task.frontmatter.status === "running";
    const cut = (text: string) => (opts.tail ? tailLines(text, opts.tail) : text);
    if (!running) return { log: cut(task.body.log), running };
    const path = join(workingAreaDir(this.root, id), "log.txt");
    const log = await readFile(path, "utf8").catch(() => task.body.log);
    return { log: cut(log), running };
  }

  /**
   * What the task's branch changed against its base (read-only). A live worktree's uncommitted
   * changes are included. 404 `branch_not_found` when `boof-runner/<id>` does not exist.
   */
  async taskDiff(
    id: string,
    opts: { path?: string; context?: number; maxBytes?: number } = {},
  ): Promise<TaskDiff> {
    const task = await this.tasks.get(id);
    if (!task) throw new OpError(404, `Task not found: ${id}`);
    const project = await this.parent.getProject(this.projectId);
    if (!project.workingDirectory) {
      throw new OpError(404, "Project has no working directory", "branch_not_found");
    }
    const info = taskReviewInfo(task);
    const settings = effectiveSettings(await this.parent.loadSettings(), project);
    const worktreeRoot = resolveWorktreeRoot(worktreeSettings(settings), project.workingDirectory);
    const worktreePath = join(worktreeRoot, id);
    const liveWorktree = await stat(worktreePath).then(
      (s) => s.isDirectory(),
      () => false,
    );
    let worktreeGit:
      | ((args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>)
      | undefined;
    if (liveWorktree) {
      let record: Awaited<ReturnType<typeof loadWorktreeRecord>>;
      try {
        record = await loadWorktreeRecord(worktreeRoot, id, project.workingDirectory);
      } catch (err) {
        throw new OpError(
          409,
          `task worktree cannot be checked (${err instanceof Error ? err.message : String(err)}); ` +
            "run the task again to recreate its record",
        );
      }
      if (!record) {
        throw new OpError(
          409,
          "task worktree has no trusted runner record; recreate or upgrade the worktree",
        );
      }
      worktreeGit = async (args) => {
        const result = await checkedWorktreeGit(record, [
          "--no-pager",
          "--no-optional-locks",
          "--literal-pathspecs",
          "-c",
          "core.quotepath=off",
          ...args,
        ]);
        return { code: result.code, stdout: result.out, stderr: result.err };
      };
    }
    try {
      return await taskDiff({
        workingDir: project.workingDirectory,
        taskId: id,
        baseSha: info.baseSha,
        baseRef: info.baseRef,
        worktreePath,
        ...(worktreeGit ? { worktreeGit } : {}),
        ...opts,
      });
    } catch (err) {
      if (err instanceof BranchNotFoundError)
        throw new OpError(404, err.message, "branch_not_found");
      if (err instanceof InvalidDiffPathError) {
        throw new OpError(400, err.message, "invalid_input", [
          { path: "path", message: err.message },
        ]);
      }
      throw err;
    }
  }

  async stopTask(id: string, actor?: Principal): Promise<{ ok: true }> {
    const task = await this.tasks.get(id);
    if (!task) throw new OpError(404, `Task not found: ${id}`);
    await this.assertMayControl(task, actor);
    await this.tasks.whileRunning(id, async ({ controlDir }) => {
      const now = new Date().toISOString();
      await atomicWrite(join(controlDir, "stop"), now + "\n");
      await appendFile(
        join(workingAreaDir(this.root, id), "log.txt"),
        `\n\n### Stop requested\n${now}\n`,
        "utf8",
      ).catch(() => {});
    });
    return { ok: true };
  }

  async injectPrompt(
    id: string,
    prompt: string,
    actor?: Principal,
    mode: InjectMode = "next-step",
    model?: string,
  ): Promise<{ ok: true; mode: InjectMode; applied: "pending" }> {
    const text = prompt.trim();
    if (!text) throw new OpError(400, "Prompt is required");
    const task = await this.tasks.get(id);
    if (!task) throw new OpError(404, `Task not found: ${id}`);
    await this.assertMayControl(task, actor);

    const now = new Date().toISOString();
    await this.tasks.whileRunning(
      id,
      async () => {
        await appendFile(
          taskPromptInjectionsPath(this.root, id),
          `\n\n## ${now}\n${text}\n`,
          "utf8",
        );
        if (mode === "now") {
          // The pipeline interrupts the running step on this file and consumes (removes) it.
          await appendFile(
            taskSteerRequestPath(this.root, id),
            JSON.stringify({ at: now, text, ...(model ? { model } : {}) }) + "\n",
            "utf8",
          );
        }
        await appendFile(
          join(workingAreaDir(this.root, id), "log.txt"),
          `\n\n### Injected prompt${mode === "now" ? " (apply now)" : ""}\n${text}\n`,
          "utf8",
        ).catch(() => {});
      },
      // Durable copy: the control directory is deleted when the task leaves `running`.
      (t) => {
        appendInjectedEntry(t, {
          text,
          by: actor && actor.kind === "client" ? actor.name : "user",
          mode,
          ...(model ? { model } : {}),
        });
      },
    );
    return { ok: true, mode, applied: "pending" };
  }

  /** Submit answers for a parked task: write answers, mark answered, resume. */
  async submitAnswers(id: string, answers: string, actor?: Principal): Promise<Task> {
    await this.assertMayQueue(actor);
    return this.tasks.transition(
      id,
      "pending",
      (t) => {
        t.body.answers = appendAnswerRound(t.body.answers, t.body.questions, answers);
        t.frontmatter.questions = "answered";
      },
      { by: actor?.id ?? "local" },
    );
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
    actor?: Principal,
  ): Promise<Task> {
    const task = await this.tasks.get(id);
    if (!task) throw new OpError(404, `Task not found: ${id}`);
    await this.assertMayAttach(task, actor);
    if (!isAllowedAttachmentType(type)) {
      throw new OpError(400, `Unsupported attachment type: ${type || "unknown"}`);
    }
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new OpError(400, "Attachment exceeds the 25 MB limit");
    }
    const name = await this.attachments.write(id, filename, bytes);
    const entry: Attachment = { name, type, size: bytes.byteLength };
    task.frontmatter.attachments = [
      ...task.frontmatter.attachments.filter((a) => a.name !== name),
      entry,
    ];
    return this.tasks.save(task);
  }

  /**
   * A review-trust client changes attachments only on its own drafts: the prompt tells the agent
   * to read every attachment, so a file on a task a human approved would reach it unreviewed.
   */
  private async assertMayAttach(task: Task, actor?: Principal): Promise<void> {
    if (!(await this.needsApproval(actor))) return;
    await this.assertMayChange(task, "edit", actor);
    if (task.frontmatter.status !== "draft") {
      throw new OpError(
        403,
        "This client has review trust and can only change attachments of its own drafts",
        "forbidden_trust",
      );
    }
  }

  /** Remove an attachment's file and frontmatter entry. */
  async removeAttachment(id: string, name: string, actor?: Principal): Promise<Task> {
    const task = await this.tasks.get(id);
    if (!task) throw new OpError(404, `Task not found: ${id}`);
    await this.assertMayAttach(task, actor);
    await this.attachments.remove(id, name);
    task.frontmatter.attachments = task.frontmatter.attachments.filter((a) => a.name !== name);
    return this.tasks.save(task);
  }

  /** Read an attachment's bytes + its recorded MIME type for serving. */
  async getAttachment(id: string, name: string): Promise<{ bytes: Buffer; type: string }> {
    const task = await this.tasks.get(id);
    if (!task) throw new OpError(404, `Task not found: ${id}`);
    const meta = task.frontmatter.attachments.find((a) => a.name === name);
    if (!meta) throw new OpError(404, `Attachment not found: ${name}`);
    try {
      const bytes = await this.attachments.read(id, name);
      return { bytes, type: meta.type };
    } catch {
      throw new OpError(404, `Attachment file missing: ${name}`);
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
/** Statuses of tasks a template rename repoints: those that can still run (or be queued again). */
const REPOINTABLE: readonly Status[] = [
  "draft",
  "pending",
  "running",
  "action",
  "stopped",
  "failed",
];

/** Thrown inside a `modify` callback to leave a running task's file unwritten. */
class RunningTaskSkipped extends Error {}

export class TaskService {
  readonly projects: ProjectStore;
  readonly commands: CommandStore;
  readonly settingsStore: SettingsStore;
  readonly webhookSecrets: WebhookSecretStore;
  /** The n8n API key and webhook header secret (n8n/secrets.json). */
  readonly n8nSecrets: N8nSecretStore;
  /** boof's one better-ccflare client key (file or BOOF_OWLISH_API_KEY); never part of settings. */
  readonly owlishSecrets: OwlishSecretStore;
  readonly projectKeys: ProjectKeyStore;
  /** The tools, injected by the composition root (bin, desktop): Heart never builds one. */
  readonly catalog: ToolCatalog;
  private readonly cache = new Map<string, ProjectService>();
  readonly conciergeAgent: ConciergeAgent | null;
  readonly authStore: AuthStore;
  private conciergeService?: ConciergeService;
  private readonly pendingAgentRoleCache = new Map<
    string,
    { signature: string; roles: Set<string> }
  >();

  private readonly refreshSandboxHook?: (settings: Settings) => Promise<void>;
  private readonly assessSandboxHook?: () => Promise<{ ok: boolean; reason: string }>;

  constructor(
    readonly root: string,
    catalog: ToolCatalog,
    opts: {
      conciergeAgent?: ConciergeAgent | null;
      authStore?: AuthStore;
      refreshSandbox?: (settings: Settings) => Promise<void>;
      assessSandbox?: () => Promise<{ ok: boolean; reason: string }>;
    } = {},
  ) {
    this.projects = new ProjectStore(root, { isGitRepo, repoCommonDir, initGitRepo });
    this.commands = new CommandStore(root);
    this.settingsStore = new SettingsStore(root);
    this.webhookSecrets = new WebhookSecretStore(root);
    this.n8nSecrets = new N8nSecretStore(root);
    this.owlishSecrets = new OwlishSecretStore(root);
    this.projectKeys = new ProjectKeyStore(root);
    void this.owlishSecrets.tighten().catch(() => {
      console.error("could not secure Owlish secret storage");
    });
    this.catalog = catalog;
    this.conciergeAgent = opts.conciergeAgent ?? null;
    this.authStore = opts.authStore ?? new AuthStore(root);
    this.refreshSandboxHook = opts.refreshSandbox;
    this.assessSandboxHook = opts.assessSandbox;
  }

  private owlishClientCache?: { id: string; client: OwlishClient };

  /**
   * The better-ccflare client for `settings.owlish` and boof's key, or null when no pool is
   * configured. One client per (url, key), so its 10 s health cache is shared by every caller.
   */
  async owlishClient(): Promise<{ client: OwlishClient; url: string; healthGate: string } | null> {
    const owlish = (await this.loadSettings()).owlish;
    if (!owlish) return null;
    const key = await this.owlishSecrets.get();
    const id = `${owlish.url}\n${key ?? ""}`;
    if (this.owlishClientCache?.id !== id) {
      this.owlishClientCache = {
        id,
        client: new OwlishClient({ url: owlish.url, apiKey: key ?? undefined }),
      };
    }
    return {
      client: this.owlishClientCache.client,
      url: owlish.url,
      healthGate: owlish.healthGate,
    };
  }

  async hasProjectKey(projectId: string): Promise<boolean> {
    return this.projectKeys.has(projectId).catch(() => false);
  }

  private agentSdkCache?: { id: string; at: number; value: AgentSdkEligibility };

  /**
   * Whether claude-agent may use the gateway: every account is API-key auth (checked with the admin
   * client key) and an api-only agent key is stored. Never throws and never queries without a key:
   * an unreadable or missing key is a closed gate with a key-free reason. `refresh` skips the 10 s cache.
   */
  async agentSdkEligibility(refresh = false): Promise<AgentSdkEligibility> {
    const owlish = (await this.loadSettings()).owlish;
    const closed = (reason: string): AgentSdkEligibility => ({
      gateway: "checked",
      allowed: false,
      reason,
      blocking: [],
      checkedAt: new Date().toISOString(),
    });
    if (!owlish) {
      const now = new Date().toISOString();
      return {
        gateway: "absent",
        allowed: false,
        reason: "no better-ccflare gateway is configured",
        blocking: [],
        checkedAt: now,
      };
    }
    let key: string | null;
    try {
      key = await this.owlishSecrets.get();
    } catch {
      return closed("authentication settings or credentials could not be read");
    }
    if (!key) return closed("no better-ccflare client key is configured");
    const hasAgentKey = await this.owlishSecrets
      .getAgent()
      .then((k) => Boolean(k))
      .catch(() => false);
    const id = `${owlish.url}\n${createHash("sha256").update(key).digest("hex")}`;
    const cached = this.agentSdkCache;
    let value: AgentSdkEligibility;
    if (!refresh && cached?.id === id && Date.now() - cached.at < 10_000) value = cached.value;
    else {
      value = await new OwlishClient({ url: owlish.url, apiKey: key }).agentSdkEligibility();
      this.agentSdkCache = { id, at: Date.now(), value };
    }
    return withAgentKey(value, hasAgentKey);
  }

  async agentAuthStatus(authorized: (projectId: string) => boolean) {
    const settings = await this.loadSettings();
    const result = [];
    let gatewayEligibility: AgentSdkEligibility | null | undefined;
    // One admin-route probe for the whole status. A key the gateway accepts is not separate.
    let agentProbe: AdminRouteProbe | undefined;
    const projects = (await this.listProjects()).filter(
      (project) => authorized(project.id) && !project.archived,
    );
    // Pending-role scans are directory reads. One project at a time left each read waiting on
    // the thread pool behind the event streams.
    const pendingRolesByProject = new Map(
      await Promise.all(
        projects.map(
          async (project) => [project.id, await this.pendingAgentRoles(project.id)] as const,
        ),
      ),
    );
    for (const project of projects) {
      const effective = effectiveSettings(settings, project);
      const pendingRoles = pendingRolesByProject.get(project.id) ?? new Set<string>();
      const roles = (["planner", "developer", "observer", "reviewer"] as const).filter(
        (role) => effective.roles[role]?.tool === "claude-agent" || pendingRoles.has(role),
      );
      if (!roles.length) continue;
      const unavailable = this.catalog.get("claude-agent")?.unavailableReason;
      if (unavailable) {
        result.push({
          projectId: project.id,
          roles: [...roles],
          allowed: false,
          via: null,
          reason: unavailable,
        });
        continue;
      }
      let hasProjectKey = false;
      try {
        hasProjectKey = await this.hasProjectKey(project.id);
      } catch {
        result.push({
          projectId: project.id,
          roles: [...roles],
          allowed: false,
          via: null,
          reason: agentAuthRefusalMessage(
            project.name,
            "authentication settings or credentials could not be read",
          ),
        });
        continue;
      }
      const gateway = settings.owlish;
      const useGateway = (project.claudeAgent?.auth ?? "gateway") === "gateway";
      let agentKey: string | null = null;
      let adminKey: string | null = null;
      try {
        agentKey = await this.owlishSecrets.getAgent();
        adminKey = await this.owlishSecrets.get();
      } catch {
        result.push({
          projectId: project.id,
          roles: [...roles],
          allowed: false,
          via: null,
          reason: agentAuthRefusalMessage(
            project.name,
            "authentication settings or credentials could not be read",
          ),
        });
        continue;
      }
      const hasAgentKey = Boolean(agentKey);
      let keysAreSeparate = agentKeyIsSeparate(adminKey, agentKey);
      if (gateway && useGateway && agentKey && keysAreSeparate) {
        agentProbe ??= await new OwlishClient({
          url: gateway.url,
          apiKey: agentKey,
        }).probeAdminRoute();
        // An outage is not "the keys are the same". Accepted means this key can read the
        // admin route, so it is not a separate api-only key. Unknown: the gateway is down.
        if (agentProbe === "unknown") {
          result.push({
            projectId: project.id,
            roles: [...roles],
            allowed: false,
            via: null,
            reason: agentAuthRefusalMessage(
              project.name,
              "the better-ccflare gateway is unreachable",
            ),
          });
          continue;
        }
        if (agentProbe === "accepted") keysAreSeparate = false;
      }
      if (
        gateway &&
        useGateway &&
        hasAgentKey &&
        keysAreSeparate &&
        gatewayEligibility === undefined
      )
        gatewayEligibility = await this.agentSdkEligibility();
      const eligibility =
        gateway && useGateway
          ? hasAgentKey && keysAreSeparate
            ? (gatewayEligibility ?? null)
            : {
                gateway: "checked" as const,
                allowed: true,
                reason: "",
                blocking: [],
                checkedAt: new Date().toISOString(),
              }
          : null;
      const decision = decideAgentAuth({
        projectName: project.name,
        choice: project.claudeAgent?.auth ?? "gateway",
        gatewayConfigured: !!gateway,
        eligibility,
        hasProjectKey,
        // agentSdkEligibility() already applied the agent-key rule: `allowed` implies a key.
        hasAgentKey,
        keysAreSeparate,
      });
      const waiting = hasAgentKey && keysAreSeparate && !!eligibility?.failure;
      result.push({
        projectId: project.id,
        roles: [...roles],
        allowed: waiting ? false : decision.ok,
        via: decision.ok ? decision.via : null,
        reason: waiting
          ? agentAuthRefusalMessage(
              project.name,
              "waiting for the gateway: eligibility could not be checked",
            )
          : decision.ok
            ? null
            : decision.reason,
      });
    }
    return result;
  }

  /**
   * Pending task overrides are needed for the status summary. The pending directory mtime is
   * the fingerprint: a task file is created, removed or replaced by rename, and that changes
   * the directory. An unchanged directory then avoids parsing on each poll. Finished tasks are
   * not in this directory and are not read.
   */
  private async pendingAgentRoles(projectId: string): Promise<Set<string>> {
    const pendingDir = join(this.projects.dir(projectId), "tasks", "pending");
    let signature = "missing";
    try {
      const info = await stat(pendingDir, { bigint: true });
      signature = String(info.mtimeNs);
    } catch {
      // A missing pending directory is an empty list.
    }
    const cached = this.pendingAgentRoleCache.get(projectId);
    if (cached?.signature === signature) return cached.roles;
    const tasks = await new TaskStore(this.projects.dir(projectId)).listByStatus("pending");
    const roles = new Set<string>();
    for (const task of tasks) {
      for (const [role, tool] of Object.entries(task.frontmatter.tools ?? {}))
        if (tool?.tool === "claude-agent") roles.add(role);
    }
    this.pendingAgentRoleCache.set(projectId, { signature, roles });
    return roles;
  }

  /** The pool right now: `absent` (no request) without `settings.owlish`; never throws. */
  async poolStatus(): Promise<PoolStatus> {
    try {
      const pool = await this.owlishClient();
      return pool ? await pool.client.health() : { ...ABSENT_POOL };
    } catch {
      // An unreadable key file must not take runner.status down; /health needs no key anyway.
      const owlish = (await this.loadSettings()).owlish;
      return owlish ? await new OwlishClient({ url: owlish.url }).health() : { ...ABSENT_POOL };
    }
  }

  /** Run a gateway call: an absent pool is 409, a gateway failure 502 (no key, no response body). */
  async withPool<T>(fn: (client: OwlishClient) => Promise<T>): Promise<T> {
    const pool = await this.owlishClient();
    if (!pool) {
      throw new OpError(
        409,
        "No account pool is configured (settings.owlish is not set)",
        "not_configured",
      );
    }
    try {
      return await fn(pool.client);
    } catch (err) {
      if (err instanceof OwlishError) throw new OpError(502, err.message, "gateway_error");
      throw err;
    }
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

  /**
   * The check task for an edited n8n workflow (the edit watcher's, `by: "n8n-watcher"`): an open
   * (draft or pending) task for the same workflow is updated in place, otherwise one is created,
   * as a draft unless `opts.queue`. 404 `project_not_found` for an unknown project.
   */
  async createN8nCheckTask(
    projectId: string,
    rawCheck: { workflowId: string; workflowName: string; webhookPath: string; updatedAt: string },
    opts: { queue: boolean },
  ): Promise<{ id: string; created: boolean }> {
    const project = await this.requireProject(projectId);
    const check = {
      ...rawCheck,
      workflowName: cleanN8nName(rawCheck.workflowName, rawCheck.workflowId),
    };
    const title = `Check n8n workflow "${check.workflowName}" after edit`;
    const prompt = `Runs the n8n workflow "${check.workflowName}" (${check.workflowId}) once with boof.kind = "check" and passes when its callback reports ok. Created by boof after the workflow changed in n8n at ${check.updatedAt}.`;
    const start = Date.now();
    const audit = (task: string, updated: boolean) =>
      auditOperation(this.root, {
        principal: { id: "n8n-watcher", kind: "server" },
        action: "n8n:check-task",
        via: "server",
        project: projectId,
        ok: true,
        ms: Date.now() - start,
        at: start,
        extra: { workflowId: check.workflowId, task, ...(updated ? { updated: true } : {}) },
      });
    const open = (await project.tasks.list()).find(
      (t) =>
        (t.frontmatter.status === "draft" || t.frontmatter.status === "pending") &&
        t.frontmatter.n8nCheck?.workflowId === check.workflowId,
    );
    if (open) {
      await project.tasks.modify(open.frontmatter.id, (t) => {
        t.frontmatter.n8nCheck = { ...check };
        t.frontmatter.title = title;
        t.body.prompt = prompt;
      });
      await audit(open.frontmatter.id, true);
      return { id: open.frontmatter.id, created: false };
    }
    const task = await createTaskInHierarchy(
      project.root,
      newTask(
        {
          id: "pending-id",
          title,
          status: opts.queue ? "pending" : "draft",
          priority: 50,
          skip: false,
          labels: ["n8n-check"],
          command: null,
          attachments: [],
          questions: "none",
          runs: 1,
          completedRuns: 0,
          n8nCheck: { ...check },
          created: "",
          updated: "",
        },
        prompt,
      ),
      { by: "n8n-watcher" },
    );
    await audit(task.frontmatter.id, false);
    return { id: task.frontmatter.id, created: true };
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
   * Register or create a project. A non-local principal may only use a directory whose realpath
   * (for `new`, of its deepest existing ancestor plus the rest) is under
   * `security.allowedProjectRoots`, and never `/`, the home directory or the data root; for
   * `auto` the projects root itself must be under an allowed root. Otherwise 403
   * `project_root_not_allowed`.
   */
  async createProject(
    input: CreateProjectBodyInput & { origin?: ProjectOrigin },
    actor?: Principal,
  ): Promise<Project> {
    await this.assertMayChangeProject(input, actor, true);
    const { path, workingDirectory, brief, ...rest } = input;
    const mode = path?.mode ?? "existing";
    const directory = path?.mode === "auto" ? undefined : (path?.directory ?? workingDirectory);
    const projectsRoot = resolveProjectsRoot(await this.loadSettings());
    let assertTarget: ((real: string) => Promise<void>) | undefined;
    if (actor && !this.actsAsLocal(actor)) {
      await this.assertWorktreeRootAllowed(actor, rest.worktree?.root, directory);
      // Vet the path as given (fast path), then hand the store the same check to run on the
      // directory it really uses, under the create lock and after the mkdir.
      const why =
        "settings.projectsRoot is not under an allowed project root (add it to security.allowedProjectRoots to let API clients create projects automatically)";
      // The directory made for a project must be inside a root, never the root itself; only the
      // projects root of `auto` may be one (it is the parent, not the project).
      const check = (dir: string, w?: string, strict = mode !== "existing") =>
        this.assertRegistrationAllowed(actor, dir, { mayNotExist: true, strict, why: w });
      if (mode === "auto") {
        await check(projectsRoot, why, false);
        // The final directory is <projectsRoot>/<id>; an id that is a symlink must not lead out.
        if (rest.id !== undefined) {
          await check(
            join(projectsRoot, rest.id),
            `the directory for id '${rest.id}' under settings.projectsRoot leads outside the allowed project roots`,
          );
        }
      } else {
        await this.assertRegistrationAllowed(actor, directory ?? "", {
          mayNotExist: mode === "new",
          strict: mode === "new",
        });
      }
      assertTarget = (real) =>
        check(
          real,
          mode === "auto" ? "the new directory is outside the allowed project roots" : undefined,
        );
    }
    try {
      const project = await this.projects.create({
        ...rest,
        workingDirectory: directory,
        brief,
        assertTarget,
        path:
          path?.mode === "auto"
            ? { mode: "auto", projectsRoot }
            : path?.mode === "new"
              ? { mode: "new", confirm: path.confirm }
              : { mode: "existing" },
        origin:
          input.origin ??
          (actor?.kind === "client" ? { kind: "api", client: actor.id } : { kind: "ui" }),
      });
      await pruneStaleWorktrees(project.workingDirectory).catch((err) =>
        console.error(`could not prune worktrees of project ${project.id}:`, err),
      );
      return project;
    } catch (err) {
      throw this.mapProjectError(err, actor);
    }
  }

  /**
   * A review-trust client may change only `name`, `labels` and `paused` of a project: the rest
   * steers work a human approved (the brief is printed into every prompt, `defaultBase` and
   * `workingDirectory` decide where tasks run, roles, review, worktree, retries and budget decide
   * how). It may not create a project at all: that registers a directory and a queue.
   */
  private async assertMayChangeProject(
    values: object,
    actor: Principal | undefined,
    creating: boolean,
  ): Promise<void> {
    const review =
      actor?.kind === "client" &&
      actor.trust === "review" &&
      (actor.alwaysReview ||
        securitySettings(await this.loadSettings()).externalTasksRequireApproval);
    if (!review) return;
    if (creating) {
      throw new OpError(
        403,
        "This client has review trust and cannot create projects; a human or a trusted client must",
        "forbidden_trust",
      );
    }
    const ALLOWED = new Set(["name", "labels", "paused"]);
    // A human's pause is theirs to lift: a restricted caller may pause, never resume.
    const resumes = (values as { paused?: unknown }).paused === false;
    const touched = Object.entries(values)
      .filter(([k, v]) => v !== undefined && (!ALLOWED.has(k) || (k === "paused" && resumes)))
      .map(([k]) => k);
    if (touched.length > 0) {
      throw new OpError(
        403,
        `This client has review trust and may change only name, labels and pausing of a project (not ${touched.join(", ")})`,
        "forbidden_trust",
      );
    }
  }

  async updateProject(
    id: string,
    patch: ProjectPatch,
    actor?: Principal,
    expectedUpdated?: string,
  ): Promise<Project> {
    // Archiving and unarchiving are operator actions, like removing a project: a review-trust
    // client may not do either, whatever `externalTasksRequireApproval` says.
    if (actor?.kind === "client" && actor.trust === "review" && patch.archived !== undefined) {
      throw new OpError(
        403,
        "This client has review trust and cannot archive or unarchive projects; a human or a trusted client must",
        "forbidden_trust",
      );
    }
    await this.assertMayChangeProject(patch, actor, false);
    if (
      actor &&
      !this.actsAsLocal(actor) &&
      (patch.worktree !== undefined || patch.workingDirectory !== undefined)
    ) {
      // A relative root resolves against the directory, so moving the directory changes where
      // the stored root points: check the effective pair, patched or stored.
      const current = await this.getProject(id);
      const root = patch.worktree !== undefined ? patch.worktree?.root : current.worktree?.root;
      await this.assertWorktreeRootAllowed(
        actor,
        root,
        patch.workingDirectory ?? current.workingDirectory,
      );
    }
    let assertTarget: ((real: string) => Promise<void>) | undefined;
    if (patch.workingDirectory !== undefined && actor && !this.actsAsLocal(actor)) {
      await this.assertRegistrationAllowed(actor, patch.workingDirectory);
      // The store resolves the path again; check the directory it really uses.
      assertTarget = (real) => this.assertRegistrationAllowed(actor, real);
    }
    if (patch.profile) {
      const known = (await this.loadSettings()).profiles ?? [];
      if (!known.some((profile) => profile.id === patch.profile)) {
        throw new OpError(400, `Unknown profile: ${patch.profile}`, "invalid_input");
      }
    }
    try {
      return await this.projects.update(id, patch, { assertTarget, expectedUpdated });
    } catch (err) {
      throw this.mapProjectError(err, actor);
    }
  }

  /** Archiving hides a project from the queue: a review-trust client may not (see `assertMayChangeProject`). */
  archiveProject(id: string, actor?: Principal): Promise<Project> {
    return this.updateProject(id, { archived: true }, actor);
  }

  async unarchiveProject(id: string, actor?: Principal): Promise<Project> {
    const project = await this.updateProject(id, { archived: false }, actor);
    await pruneStaleWorktrees(project.workingDirectory).catch((err) =>
      console.error(`could not prune worktrees of project ${project.id}:`, err),
    );
    return project;
  }

  pauseProject(id: string, actor?: Principal): Promise<Project> {
    return this.updateProject(id, { paused: true }, actor);
  }

  resumeProject(id: string, actor?: Principal): Promise<Project> {
    return this.updateProject(id, { paused: false }, actor);
  }

  /** Archive (default) or purge a project; refused while one of its tasks runs. */
  async removeProject(
    id: string,
    opts: { purge?: boolean } = {},
    actor?: Principal,
  ): Promise<{ ok: true }> {
    // Archiving and purging a project are operator actions, not a review-trust client's: refused
    // whatever `externalTasksRequireApproval` says (`assertMayChangeProject` only applies when
    // that setting or `alwaysReview` is on).
    if (actor?.kind === "client" && actor.trust === "review") {
      throw new OpError(
        403,
        "This client has review trust and cannot archive or delete projects; a human or a trusted client must",
        "forbidden_trust",
      );
    }
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

  /** The local principal, no principal at all, or a client key the server treats as the local operator. */
  private actsAsLocal(actor?: Principal): boolean {
    return actor === undefined || actor.kind === "local" || actor.operator === true;
  }

  /** Every ProjectError code is mapped here explicitly; the `never` default keeps it exhaustive. */
  private mapProjectError(err: unknown, actor?: Principal): unknown {
    if (!(err instanceof ProjectError)) return err;
    const remote = !this.actsAsLocal(actor);
    switch (err.code) {
      case "not_found":
        return new OpError(404, err.message, "project_not_found");
      case "id_taken":
        return new OpError(409, err.message, "conflict");
      case "modified":
        return new OpError(409, err.message, "project_modified");
      case "duplicate":
      case "same_repo":
        return new OpError(409, err.message, "project_exists");
      case "has_running_task":
        return new OpError(409, err.message, "project_busy");
      case "busy":
        // The message names the lock holder's pid; log it, do not send it.
        console.error(err.message);
        return new OpError(
          409,
          "Another project is being created right now; try again in a moment.",
          "project_busy",
        );
      case "directory_not_empty":
        return new OpError(409, err.message, "directory_not_empty");
      case "not_git_repo":
      case "inside_data_root":
      case "directory_not_allowed":
        return remote
          ? new OpError(403, err.message, "project_root_not_allowed")
          : new OpError(
              400,
              err.message,
              err.code === "not_git_repo" ? "not_a_git_repo" : "invalid_input",
            );
      case "directory_missing":
      case "not_a_directory":
      case "directory_create_failed":
        // The directory was already checked to be inside an allowed root, so its state is no secret.
        if (err.code === "directory_create_failed") console.error(err.message);
        return new OpError(400, err.message, "invalid_input");
      default: {
        const unmapped: never = err.code;
        console.error(`unmapped project error code: ${String(unmapped)}`);
        return new OpError(500, "Internal error", "internal");
      }
    }
  }

  /**
   * A non-local principal may set `worktree.root` only to a place under
   * `security.allowedProjectRoots` (real path, symlinks and `..` resolved), never `/`, the home
   * directory or the data root. A relative root resolves against `base` (the project's directory);
   * with no project to resolve it against it is refused.
   */
  private async assertWorktreeRootAllowed(
    actor: Principal,
    root: string | undefined,
    base: string | undefined,
  ): Promise<void> {
    if (root === undefined) return;
    const expanded = expandHome(root);
    let abs = expanded;
    if (!isAbsolute(expanded)) {
      if (!base) {
        throw new OpError(
          403,
          "Project root not allowed: worktree.root must be an absolute path here",
          "project_root_not_allowed",
        );
      }
      abs = resolve(base, expanded);
    }
    await this.assertRegistrationAllowed(actor, abs, {
      mayNotExist: true,
      why: "worktree.root is outside the allowed project roots",
    });
    const real = (await resolveUnbornPath(abs)).real;
    const dataRoot = await realpath(this.root).catch(() => resolve(this.root));
    if (isInsidePath(dataRoot, real)) {
      throw new OpError(
        403,
        "Project root not allowed: worktree.root cannot be inside the data root",
        "project_root_not_allowed",
      );
    }
  }

  private async assertRegistrationAllowed(
    actor: Principal,
    dir: string,
    opts: { mayNotExist?: boolean; strict?: boolean; why?: string } = {},
  ): Promise<void> {
    const { allowedProjectRoots } = securitySettings(await this.loadSettings());
    const deny = (why: string): OpError =>
      new OpError(
        403,
        `Project root not allowed: ${why}`,
        "project_root_not_allowed",
        hasScope(actor, "admin") ? { allowedRoots: allowedProjectRoots } : undefined,
      );
    if (allowedProjectRoots.length === 0) throw deny("no allowedProjectRoots are configured");
    let real: string;
    if (opts.mayNotExist) {
      try {
        real = (await resolveUnbornPath(dir)).real;
      } catch {
        throw new OpError(400, `Not a usable absolute path: ${dir}`, "invalid_input");
      }
    } else {
      try {
        real = await realpath(dir);
      } catch {
        throw new OpError(400, `Directory does not exist: ${dir}`, "invalid_input");
      }
    }
    if (real === resolve("/") || real === (await realpath(homedir()).catch(() => homedir()))) {
      throw deny("the filesystem root and the home directory cannot be projects");
    }
    const roots = await Promise.all(
      allowedProjectRoots.map(async (r) => {
        // A root that does not exist yet (the default ~/boof-projects) still counts, resolved
        // through its deepest existing ancestor like the target.
        return resolveUnbornPath(expandHome(r)).then(
          (u) => u.real,
          () => null,
        );
      }),
    );
    const inside = roots.some((r) => {
      if (!r) return false;
      return isInsidePath(r, real) && !(opts.strict && real === r);
    });
    if (!inside) {
      throw deny(
        opts.why ??
          (opts.strict && roots.includes(real)
            ? "a new project must be a folder inside an allowed root, not the root itself"
            : "outside the allowed project roots"),
      );
    }
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

  /**
   * Today's budget figures for the projects `allowed` accepts (archived ones excluded). Scopes of
   * other projects are left out; the global and tool scopes are always included.
   */
  async budgetStatus(allowed: (projectId: string) => boolean = () => true): Promise<BudgetStatus> {
    const projects = (await this.projects.list()).filter((p) => allowed(p.id));
    return evaluateBudget(this.root, await this.settingsStore.load(), projects);
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
    const skippedTasks: string[] = [];
    if (tpl.id !== oldId) {
      for (const p of await this.projects.list({ includeArchived: true })) {
        const store = this.forProject(p.id).tasks;
        for (const t of await store.list()) {
          if (t.frontmatter.command !== oldId) continue;
          // Finished and archived tasks record what they ran with: leave them as they are.
          if (!REPOINTABLE.includes(t.frontmatter.status)) continue;
          // A running task keeps its own copy of the instructions and owns its file: leave it.
          // The status is checked again under the task lock, since the task may have started
          // since the scan; the throw leaves the file unwritten.
          try {
            await store.modify(t.frontmatter.id, (cur) => {
              if (cur.frontmatter.status === "running") throw new RunningTaskSkipped();
              if (cur.frontmatter.command !== oldId) return;
              cur.frontmatter.command = tpl.id;
              cur.body.command = body;
            });
          } catch (e) {
            if (!(e instanceof RunningTaskSkipped)) throw e;
            skippedTasks.push(t.frontmatter.id);
          }
        }
      }
      await this.commands.delete(oldId);
    }
    return skippedTasks.length ? { ...tpl, skippedTasks } : tpl;
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

  /**
   * The assistant, built by the composition root (`attachConcierge`). TaskService does not
   * construct it: that would import the operation registry and the concierge MCP server, which
   * import TaskService.
   */
  useConcierge(concierge: ConciergeService): void {
    this.conciergeService = concierge;
  }

  hasConcierge(): boolean {
    return this.conciergeService !== undefined;
  }

  concierge(): ConciergeService {
    if (!this.conciergeService) throw new Error("ConciergeService was not provided");
    return this.conciergeService;
  }

  loadSettings(): Promise<Settings> {
    return this.settingsStore.load();
  }

  /** Apply a settings patch; a change of `runner.enabled` appends a global `runner.enabled` event. */
  async updateSettings(
    patch: SettingsPatch,
    actor?: Principal,
    expectedVersion?: string,
  ): Promise<Settings> {
    if (actor && !this.actsAsLocal(actor)) {
      await this.assertWorktreeRootAllowed(actor, patch.worktree?.root, undefined);
    }
    if (patch.defaultProject) await this.getProject(patch.defaultProject);
    const turningOn = patch.runner?.sandbox?.mode === "enforce";
    const enabledChanging = patch.runner?.enabled !== undefined;
    const current = turningOn || enabledChanging ? await this.loadSettings() : undefined;
    if (
      turningOn &&
      current &&
      current.runner.sandbox.mode !== "enforce" &&
      this.assessSandboxHook
    ) {
      let report: { ok: boolean; reason: string };
      try {
        report = await this.assessSandboxHook();
      } catch (err) {
        if (err instanceof OpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new OpError(
          409,
          message.replace(/^sandbox_unavailable:\s*/, ""),
          "sandbox_unavailable",
        );
      }
      if (!report.ok) throw new OpError(409, report.reason, "sandbox_unavailable");
    }
    const before = enabledChanging ? current!.runner.enabled : undefined;
    const profilesChange = patch.profiles !== undefined || patch.activeProfile !== undefined;
    const profileUsers = profilesChange
      ? (await this.projects.list({ includeArchived: true })).map((p) => ({
          id: p.id,
          profile: p.profile,
        }))
      : [];
    const next = await this.settingsStore.update(
      patch,
      (current) => {
        if (expectedVersion !== undefined && expectedVersion !== settingsVersion(current)) {
          throw new OpError(
            409,
            "The settings changed since the version you last read; reload and retry.",
            "settings_modified",
          );
        }
      },
      (current, candidate) => {
        if (!profilesChange) return;
        // The schema checks duplicate ids and a missing active profile (SettingsSchema.parse in
        // save); here: tool ids that exist, and no deletion of a profile a project uses.
        const problem = checkProfiles(current, candidate, {
          knownTools: this.catalog.list().map((tool) => tool.id),
          projects: profileUsers,
        });
        if (problem?.code === "profile_in_use") {
          throw new OpError(409, problem.message, "profile_in_use");
        }
        if (problem) throw new OpError(400, problem.message, "invalid_input");
      },
    );
    if (before !== undefined && before !== next.runner.enabled) {
      await appendEvent(this.root, {
        type: "runner.enabled",
        value: next.runner.enabled,
        by: actor?.id ?? "local",
      });
    }
    if (patch.runner?.sandbox) {
      await this.refreshSandboxHook?.(next).catch((err) => {
        console.error("sandbox self-test failed:", err);
      });
    }
    return next;
  }

  /**
   * Run the tools' health checks (each sends a short, paid prompt) and remember the results.
   * Concurrent calls share one check, and a check less than a minute old is returned as it is.
   */
  async health(): Promise<Record<string, HealthResult>> {
    const { runner } = await this.loadSettings();
    return this.catalog.healthAll(HEALTH_COOLDOWN_MS, {
      inheritMcpServers: runner.inheritMcpServers === true,
    });
  }

  /**
   * Which tools are installed. Free: no prompt. Cached for five minutes; `refresh` re-checks, but
   * a check younger than ten seconds is reused.
   */
  async harnesses(refresh = false): Promise<{
    tools: Record<string, InstallResult & { displayName: string }>;
    anyInstalled: boolean;
    checkedAt: string;
  }> {
    const installs = await this.catalog.installedAll(refresh ? 10_000 : 5 * 60_000);
    const tools: Record<string, InstallResult & { displayName: string }> = {};
    let oldest = Date.now();
    for (const info of this.catalog.list()) {
      const found = installs[info.id];
      if (!found || found.hidden) continue;
      const { checkedAt, hidden: _hidden, ...install } = found;
      oldest = Math.min(oldest, Date.parse(checkedAt));
      tools[info.id] = { displayName: info.displayName, ...install };
    }
    return {
      tools,
      anyInstalled: Object.values(tools).some((t) => t.installed),
      checkedAt: new Date(oldest).toISOString(),
    };
  }

  /** The last health results of this process, without running a tool (empty until a check ran). */
  cachedHealth(): Readonly<Record<string, Readonly<CachedHealth>>> {
    return this.catalog.lastHealth();
  }

  /** Ask the tools for their models now (spawns processes) and remember the lists. */
  listModels(): Promise<Readonly<Record<string, readonly string[]>>> {
    return this.catalog.modelsAll();
  }

  /** The last model lists (or the built-in defaults), without running a tool. */
  cachedModels(): Readonly<Record<string, readonly string[]>> {
    return this.catalog.cachedModels();
  }
}

function projectNotFound(id: string): OpError {
  return new OpError(404, `Project not found: ${id}`, "project_not_found");
}

/** A health check younger than this is not repeated: each check is a paid model call per tool. */
const HEALTH_COOLDOWN_MS = 60_000;

const ORIGIN_KIND = { harness: "api", mcp: "mcp", ui: "ui", cli: "cli" } as const;

/** Who submitted a task or epic: the client, or nobody for the local principal. */
function originOf(actor?: Principal): TaskOrigin | undefined {
  return actor?.kind === "client"
    ? { kind: ORIGIN_KIND[actor.clientKind ?? "harness"], client: actor.id }
    : undefined;
}

/** The last `n` lines of `text`; a trailing newline is kept and does not count as a line. */
export function tailLines(text: string, n: number): string {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  if (lines.length <= n) return text;
  return lines.slice(-n).join("\n") + (body === text ? "" : "\n");
}
