import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  buildHierarchyIndex,
  EpicError,
  EpicStore,
  HierarchyError,
  InvalidIdError,
  ProjectStore,
  removeEpic,
  SettingsStore,
  TaskStore,
  scaffoldDataRoot,
} from "@boof-runner/shared";
import { ZodError } from "zod";

export const EPIC_HELP = `boof-runner epic — manage the epics (named groups of tasks) of a project

Usage:
  boof-runner epic add <title> [--id <kebab>] [--priority <n>] [--description <text>] [--project <id>] [-d <data>]
  boof-runner epic list [--all] [--json] [--project <id>] [-d <data>]
  boof-runner epic archive <id> [--undo] [--project <id>] [-d <data>]
  boof-runner epic remove <id> [--detach] [--project <id>] [-d <data>]

add      Create an epic. The id defaults to the title in kebab-case (none is reserved).
list     One line per epic: id, priority, done/total top-level tasks, title. --all adds archived ones.
archive  Hide an epic from the default list; its tasks keep it. --undo brings it back.
remove   Delete an epic. Refused while tasks name it, unless --detach clears their epic.
The project is --project, else settings.defaultProject.`;

/** A command-line mistake or refusal: printed as `<command>: <message>`, exit 1. */
export class CliUsageError extends Error {}

/**
 * The project directory a hierarchy command works on: `--project`, else the default project.
 * Uses the stores only (no repository lookup), so these commands stay within shared.
 */
export async function resolveProjectDir(
  root: string,
  projectOpt: string | undefined,
): Promise<{ id: string; dir: string }> {
  const projects = new ProjectStore(root);
  const id = projectOpt ?? (await new SettingsStore(root).load()).defaultProject ?? undefined;
  if (!id) {
    throw new CliUsageError(
      "no project: pass --project <id>, or set a default with `project add <dir> --default`.",
    );
  }
  const project = await projects.get(id);
  if (!project) throw new CliUsageError(`project not found: ${id}`);
  return { id, dir: projects.dir(id) };
}

export function dataRootOf(data: string | undefined, defaultRoot: () => string): string {
  return data ? (isAbsolute(data) ? data : resolve(process.cwd(), data)) : defaultRoot();
}

/** True for the errors a hierarchy command reports as a plain message. */
export function isExpectedCliError(e: unknown): e is Error {
  return (
    e instanceof CliUsageError ||
    e instanceof EpicError ||
    e instanceof HierarchyError ||
    e instanceof InvalidIdError ||
    e instanceof ZodError ||
    (e instanceof Error && e.name === "TaskNotFoundError")
  );
}

/** `epic` subcommand. Returns a process exit code. */
export async function epicCommand(
  argv: string[],
  defaultRoot: () => string,
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    out(EPIC_HELP);
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
        id: { type: "string" },
        priority: { type: "string" },
        description: { type: "string" },
        all: { type: "boolean" },
        json: { type: "boolean" },
        undo: { type: "boolean" },
        detach: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    err(`epic: ${(e as Error).message}\n`);
    err(EPIC_HELP);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    out(EPIC_HELP);
    return 0;
  }
  const root = dataRootOf(values.data, defaultRoot);
  await scaffoldDataRoot(root);

  try {
    const { dir } = await resolveProjectDir(root, values.project);
    const epics = new EpicStore(dir);
    switch (sub) {
      case "add": {
        const title = positionals[0]?.trim();
        if (!title) throw new CliUsageError("a title is required");
        let priority: number | undefined;
        if (values.priority !== undefined) {
          priority = Number(values.priority);
          if (!Number.isInteger(priority)) throw new CliUsageError("--priority must be an integer");
        }
        const epic = await epics.create(
          {
            title,
            ...(values.id ? { id: values.id } : {}),
            ...(values.description !== undefined ? { description: values.description } : {}),
            ...(priority !== undefined ? { priority } : {}),
          },
          { by: "cli" },
        );
        out(`Added epic '${epic.id}' (${epic.title})`);
        return 0;
      }
      case "list": {
        const [list, tasks] = await Promise.all([
          epics.list({ includeArchived: values.all }),
          new TaskStore(dir).list(),
        ]);
        const index = buildHierarchyIndex(tasks, await epics.list({ includeArchived: true }));
        const views = list.map((e) => ({ ...e, progress: index.epicProgress(e.id) }));
        if (values.json) {
          out(JSON.stringify(views, null, 2));
          return 0;
        }
        if (views.length === 0) out("No epics. Add one with: boof-runner epic add <title>");
        for (const e of views) {
          out(
            [
              e.id.padEnd(24),
              `p${e.priority}`.padEnd(5),
              `${e.progress.done}/${e.progress.total}`.padEnd(6),
              e.title + (e.archived ? "  (archived)" : ""),
            ].join("  "),
          );
        }
        return 0;
      }
      case "archive": {
        const id = positionals[0];
        if (!id) throw new CliUsageError("an epic id is required");
        await epics.update(id, { archived: !values.undo }, { by: "cli" });
        out(`${values.undo ? "Unarchived" : "Archived"} epic '${id}'`);
        return 0;
      }
      case "remove": {
        const id = positionals[0];
        if (!id) throw new CliUsageError("an epic id is required");
        const { detached } = await removeEpic(dir, id, { detach: values.detach, by: "cli" });
        out(
          `Removed epic '${id}'${detached.length ? ` (${detached.length} task(s) detached)` : ""}`,
        );
        return 0;
      }
      default:
        err(`epic: unknown subcommand "${sub}"\n`);
        err(EPIC_HELP);
        return 1;
    }
  } catch (e) {
    if (isExpectedCliError(e)) {
      err(
        `epic ${sub}: ${e instanceof ZodError ? e.issues.map((i) => i.message).join("; ") : e.message}`,
      );
      return 1;
    }
    throw e;
  }
}
