import { join } from "node:path";
import type { Status } from "./schema.js";

const KEBAB_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Thrown when an id that would become part of a filesystem path is not kebab-case. */
export class InvalidIdError extends Error {
  constructor(public readonly id: string) {
    super(`Invalid id: ${JSON.stringify(id)} (must be kebab-case [a-z0-9-])`);
    this.name = "InvalidIdError";
  }
}

export function isKebabId(id: unknown): id is string {
  return typeof id === "string" && id.length <= 200 && KEBAB_ID.test(id);
}

/**
 * Guard for every path builder that joins an id: rejects anything that is not
 * kebab-case, so `..`, `/`, `%2F`-decoded segments and empty ids can never
 * escape the data root.
 */
export function assertKebabId(id: string): string {
  if (!isKebabId(id)) throw new InvalidIdError(id);
  return id;
}

/** Maps each status to its directory name under <data-root>/tasks/. */
export const STATUS_DIRS: Record<Status, string> = {
  draft: "drafts",
  pending: "pending",
  running: "ongoing",
  action: "actions",
  done: "done",
  failed: "failed",
  stopped: "stopped",
  archived: "archived",
};

/** Reverse lookup: directory name → status. */
export const DIR_TO_STATUS: Record<string, Status> = Object.fromEntries(
  Object.entries(STATUS_DIRS).map(([status, dir]) => [dir, status as Status]),
) as Record<string, Status>;

/** Locations directly under the data root (layout v2). */
export interface DataRootPaths {
  root: string;
  settings: string;
  runnerPid: string;
  commands: string;
  projects: string;
  auth: string;
  authClients: string;
  audit: string;
  /** Global events (runner toggles); project events live in the project directory. */
  events: string;
  idempotency: string;
  webhooks: string;
}

export function dataRootPaths(root: string): DataRootPaths {
  return {
    root,
    settings: join(root, "settings.json"),
    runnerPid: join(root, ".runner.pid"),
    commands: join(root, "commands"),
    projects: join(root, "projects"),
    auth: join(root, "auth"),
    authClients: join(root, "auth", "clients.json"),
    audit: join(root, "audit"),
    events: join(root, "events.jsonl"),
    idempotency: join(root, "idempotency"),
    webhooks: join(root, "webhooks"),
  };
}

/** Locations of one project; `dir` is the `root` to hand to TaskStore, AttachmentStore, UsageStore. */
export interface ProjectPaths {
  dir: string;
  json: string;
  tasks: string;
  plans: string;
  usage: string;
  events: string;
}

/** Paths of project `id` (kebab-checked: the id becomes a directory name). */
export function projectPaths(root: string, id: string): ProjectPaths {
  const dir = join(root, "projects", assertKebabId(id));
  return {
    dir,
    json: join(dir, "project.json"),
    tasks: join(dir, "tasks"),
    plans: join(dir, "plans"),
    usage: join(dir, "usage.json"),
    events: join(dir, "events.jsonl"),
  };
}

export interface DataPaths extends DataRootPaths {
  /** v1 location of the task tree; in v2 tasks live under projects/<id>/tasks. */
  tasks: string;
}

/** @deprecated Use {@link dataRootPaths} and {@link projectPaths}. Kept for one release. */
export function dataPaths(root: string): DataPaths {
  return { ...dataRootPaths(root), tasks: join(root, "tasks") };
}

/** Directory for a given status, e.g. <root>/tasks/pending. */
export function statusDir(root: string, status: Status): string {
  return join(root, "tasks", STATUS_DIRS[status]);
}

/**
 * Path to a task's file. For `running` status the task lives in its own
 * working-area directory (ongoing/<id>/task.md); every other status stores it
 * as a flat file (<status-dir>/<id>.md).
 */
export function taskFilePath(root: string, status: Status, id: string): string {
  assertKebabId(id);
  if (status === "running") return join(statusDir(root, status), id, "task.md");
  return join(statusDir(root, status), `${id}.md`);
}

/** Working-area directory for a running task: <root>/tasks/ongoing/<id>/. */
export function workingAreaDir(root: string, id: string): string {
  return join(statusDir(root, "running"), assertKebabId(id));
}

/** Runtime control directory for a running task. */
export function taskControlDir(root: string, id: string): string {
  return join(workingAreaDir(root, id), "control");
}

/** Presence of this file requests cancellation of the running tool process. */
export function taskStopRequestPath(root: string, id: string): string {
  return join(taskControlDir(root, id), "stop");
}

/** User prompts injected while a task is running, consumed between pipeline steps. */
export function taskPromptInjectionsPath(root: string, id: string): string {
  return join(taskControlDir(root, id), "prompts.md");
}

/**
 * Directory holding a task's attachment files: <root>/tasks/assets/<id>/.
 * Keyed by id only, so attachments survive the task moving between status dirs.
 */
export function taskAssetsDir(root: string, id: string): string {
  return join(root, "tasks", "assets", assertKebabId(id));
}

/** Path to a single attachment file within a task's asset directory. */
export function taskAssetPath(root: string, id: string, name: string): string {
  return join(taskAssetsDir(root, id), name);
}

export function commandFilePath(root: string, id: string): string {
  return join(root, "commands", `${assertKebabId(id)}.md`);
}

export const ALL_STATUSES: Status[] = [
  "draft",
  "pending",
  "running",
  "action",
  "done",
  "failed",
  "stopped",
  "archived",
];
