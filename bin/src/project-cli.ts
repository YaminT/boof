import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  InvalidIdError,
  ProjectError,
  ProjectStore,
  SettingsStore,
  type Project,
} from "@boof-runner/shared";
import { isGitRepo, pruneStaleWorktrees, repoCommonDir } from "@boof-runner/runner";
import { scaffoldDataRoot } from "./scaffold.js";

export const PROJECT_HELP = `boof-runner project — manage the projects (git repositories) one data root serves

Usage:
  boof-runner project add <dir> [--id <kebab>] [--name <text>] [--default] [-d <data>]
  boof-runner project list [--json] [-d <data>]
  boof-runner project remove <id> [--purge] [-d <data>]

add     Register a git repository. The id defaults to the directory name. --default makes it
        the project the legacy /api/tasks routes and run/scan without --project use.
list    One line per project (* marks the default); --json prints the project records.
remove  Archive the project (its tasks are kept). --purge deletes its data directory
        (tasks, usage, plans) but never the repository. Refused while a task is running.`;

function describe(p: Project, isDefault: boolean): string {
  const state = p.archived ? "archived" : p.paused ? "paused" : "active";
  return [
    `${isDefault ? "*" : " "} ${p.id}`.padEnd(26),
    state.padEnd(9),
    p.name.padEnd(24),
    p.workingDirectory || "(no working directory)",
  ].join("  ");
}

/** `project` subcommand. Returns a process exit code. */
export async function projectCommand(
  argv: string[],
  defaultRoot: () => string,
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    out(PROJECT_HELP);
    return sub ? 0 : 1;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        data: { type: "string", short: "d" },
        id: { type: "string" },
        name: { type: "string" },
        default: { type: "boolean" },
        json: { type: "boolean" },
        purge: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    err(`project: ${(e as Error).message}\n`);
    err(PROJECT_HELP);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    out(PROJECT_HELP);
    return 0;
  }
  const root = values.data
    ? isAbsolute(values.data)
      ? values.data
      : resolve(process.cwd(), values.data)
    : defaultRoot();
  await scaffoldDataRoot(root);
  const projects = new ProjectStore(root, { isGitRepo, repoCommonDir });
  const settings = new SettingsStore(root);

  try {
    switch (sub) {
      case "add": {
        const dir = positionals[0];
        if (!dir) {
          err("project add: a repository directory is required");
          return 1;
        }
        const project = await projects.create({
          workingDirectory: isAbsolute(dir) ? dir : resolve(process.cwd(), dir),
          ...(values.id ? { id: values.id } : {}),
          ...(values.name ? { name: values.name } : {}),
          origin: { kind: "cli" },
        });
        await pruneStaleWorktrees(project.workingDirectory).catch((err) =>
          console.error(`could not prune worktrees of project ${project.id}:`, err),
        );
        if (values.default) await settings.update({ defaultProject: project.id });
        out(`Added project '${project.id}' (${project.workingDirectory})`);
        if (values.default) out(`'${project.id}' is now the default project`);
        return 0;
      }
      case "list": {
        const all = await projects.list({ includeArchived: true });
        if (values.json) {
          out(JSON.stringify(all, null, 2));
          return 0;
        }
        const def = (await settings.load()).defaultProject;
        if (all.length === 0) out("No projects. Add one with: boof-runner project add <dir>");
        for (const p of all) out(describe(p, p.id === def));
        return 0;
      }
      case "remove": {
        const id = positionals[0];
        if (!id) {
          err("project remove: a project id is required");
          return 1;
        }
        await projects.remove(id, { purge: values.purge });
        if (values.purge && (await settings.load()).defaultProject === id) {
          await settings.update({ defaultProject: null });
        }
        out(values.purge ? `Purged project '${id}'` : `Archived project '${id}'`);
        return 0;
      }
      default:
        err(`project: unknown subcommand "${sub}"\n`);
        err(PROJECT_HELP);
        return 1;
    }
  } catch (e) {
    if (e instanceof ProjectError || e instanceof InvalidIdError) {
      err(`project ${sub}: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
