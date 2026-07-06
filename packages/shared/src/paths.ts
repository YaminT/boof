import { join } from "node:path";
import type { Status } from "./schema.js";

/** Maps each status to its directory name under <data-root>/tasks/. */
export const STATUS_DIRS: Record<Status, string> = {
  draft: "drafts",
  pending: "pending",
  running: "ongoing",
  action: "actions",
  done: "done",
  failed: "failed",
  archived: "archived",
};

/** Reverse lookup: directory name → status. */
export const DIR_TO_STATUS: Record<string, Status> = Object.fromEntries(
  Object.entries(STATUS_DIRS).map(([status, dir]) => [dir, status as Status]),
) as Record<string, Status>;

export interface DataPaths {
  root: string;
  tasks: string;
  commands: string;
  settings: string;
  runnerPid: string;
}

export function dataPaths(root: string): DataPaths {
  return {
    root,
    tasks: join(root, "tasks"),
    commands: join(root, "commands"),
    settings: join(root, "settings.json"),
    runnerPid: join(root, ".runner.pid"),
  };
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
  if (status === "running") return join(statusDir(root, status), id, "task.md");
  return join(statusDir(root, status), `${id}.md`);
}

/** Working-area directory for a running task: <root>/tasks/ongoing/<id>/. */
export function workingAreaDir(root: string, id: string): string {
  return join(statusDir(root, "running"), id);
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
  return join(root, "tasks", "assets", id);
}

/** Path to a single attachment file within a task's asset directory. */
export function taskAssetPath(root: string, id: string, name: string): string {
  return join(taskAssetsDir(root, id), name);
}

export function commandFilePath(root: string, id: string): string {
  return join(root, "commands", `${id}.md`);
}

export const ALL_STATUSES: Status[] = [
  "draft",
  "pending",
  "running",
  "action",
  "done",
  "failed",
  "archived",
];
