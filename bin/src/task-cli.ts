import { parseArgs } from "node:util";
import {
  buildHierarchyIndex,
  compareTasks,
  EpicStore,
  HIERARCHY_NONE,
  matchesHierarchy,
  moveTask,
  StatusSchema,
  TaskStore,
  type Task,
  scaffoldDataRoot,
} from "@boof-runner/shared";
import { ZodError } from "zod";
import { CliUsageError, dataRootOf, isExpectedCliError, resolveProjectDir } from "./epic-cli.js";

export const TASK_HELP = `boof-runner task — list tasks with their epics and subtasks, and move them

Usage:
  boof-runner task list [--epic <id>|none] [--parent <id>|none] [--status <s>] [--json] [--project <id>] [-d <data>]
  boof-runner task move <task> [--epic <id>|none] [--parent <id>|none] [--project <id>] [-d <data>]

list  Tasks in scheduler order (priority, then oldest update); a subtask is printed under its parent.
      --epic also matches subtasks through their parent; none means no epic / a top-level task.
move  Put a task in an epic or under a parent (one level of subtasks); none clears it. A task takes
      an epic or a parent, not both: a subtask has its parent's epic.
The project is --project, else settings.defaultProject.`;

/** `task` subcommand. Returns a process exit code. */
export async function taskCommand(
  argv: string[],
  defaultRoot: () => string,
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    out(TASK_HELP);
    return sub ? 0 : 1;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        data: { type: "string", short: "d" },
        project: { type: "string" },
        epic: { type: "string" },
        parent: { type: "string" },
        status: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    err(`task: ${(e as Error).message}\n`);
    err(TASK_HELP);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    out(TASK_HELP);
    return 0;
  }
  const root = dataRootOf(values.data, defaultRoot);
  await scaffoldDataRoot(root);

  try {
    const { dir } = await resolveProjectDir(root, values.project);
    const store = new TaskStore(dir);
    switch (sub) {
      case "list": {
        const status = values.status ? StatusSchema.safeParse(values.status) : undefined;
        if (status && !status.success) throw new CliUsageError(`unknown status: ${values.status}`);
        const [all, epics] = await Promise.all([
          store.list(),
          new EpicStore(dir).list({ includeArchived: true }),
        ]);
        const index = buildHierarchyIndex(all, epics);
        const shown = all
          .filter((t) => !status?.success || t.frontmatter.status === status.data)
          .filter((t) => matchesHierarchy(t, index, { epic: values.epic, parent: values.parent }))
          .sort(compareTasks);
        if (values.json) {
          out(
            JSON.stringify(
              shown.map((t) => record(t, index.info(t))),
              null,
              2,
            ),
          );
          return 0;
        }
        const ids = new Set(shown.map((t) => t.frontmatter.id));
        const line = (t: Task, prefix: string, suffix = "") => {
          const f = t.frontmatter;
          const info = index.info(t);
          return [
            (prefix + f.id).padEnd(28),
            f.status.padEnd(8),
            `p${f.priority}`,
            info.epicId ? `epic:${info.epicId}` : "",
            info.subtasks ? `${info.subtasks.done}/${info.subtasks.total}` : "",
            f.title + suffix,
          ]
            .filter((x, i) => i === 0 || i === 1 || i === 2 || i === 5 || x !== "")
            .join("  ");
        };
        const underParent = (t: Task) => {
          const p = t.frontmatter.parentId;
          return (
            p !== undefined &&
            index.childrenOf(p).length > 0 &&
            all.some((x) => x.frontmatter.id === p)
          );
        };
        for (const t of shown) {
          const p = t.frontmatter.parentId;
          if (underParent(t) && p !== undefined && ids.has(p)) continue; // printed under its parent
          out(line(t, "", underParent(t) && p !== undefined ? `  ↳ ${p}` : ""));
          for (const c of index.childrenOf(t.frontmatter.id)) {
            if (ids.has(c.frontmatter.id)) out(line(c, "  ↳ "));
          }
        }
        return 0;
      }
      case "move": {
        const id = positionals[0];
        if (!id) throw new CliUsageError("a task id is required");
        if (values.epic === undefined && values.parent === undefined) {
          throw new CliUsageError("give --epic or --parent (none clears it)");
        }
        const clear = (v: string | undefined) =>
          v === undefined ? undefined : v === HIERARCHY_NONE ? null : v;
        const task = await moveTask(
          dir,
          id,
          { epicId: clear(values.epic), parentId: clear(values.parent) },
          { by: "cli" },
        );
        const f = task.frontmatter;
        out(
          `Moved task '${id}'${f.parentId ? ` under '${f.parentId}'` : ""}${f.epicId ? ` into epic '${f.epicId}'` : ""}`,
        );
        return 0;
      }
      default:
        err(`task: unknown subcommand "${sub}"\n`);
        err(TASK_HELP);
        return 1;
    }
  } catch (e) {
    if (isExpectedCliError(e)) {
      err(
        `task ${sub}: ${e instanceof ZodError ? e.issues.map((i) => i.message).join("; ") : e.message}`,
      );
      return 1;
    }
    throw e;
  }
}

function record(t: Task, info: ReturnType<ReturnType<typeof buildHierarchyIndex>["info"]>) {
  const f = t.frontmatter;
  return {
    id: f.id,
    title: f.title,
    status: f.status,
    priority: f.priority,
    epicId: info.epicId ?? null,
    parentId: f.parentId ?? null,
    ...(info.subtasks ? { subtasks: info.subtasks } : {}),
    ...(info.parentMissing ? { parentMissing: true } : {}),
    ...(info.epicMissing ? { epicMissing: true } : {}),
  };
}
