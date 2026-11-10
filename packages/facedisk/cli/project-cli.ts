import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  InvalidIdError,
  ProjectError,
  ProjectStore,
  SettingsStore,
  resolveProjectsRoot,
  type Project,
  scaffoldDataRoot,
  initGitRepo,
  isGitRepo,
  pruneStaleWorktrees,
  repoCommonDir,
} from "@boof/heart";
import { beginCliAudit } from "./cli-audit.js";

export const PROJECT_HELP = `boof-runner project — manage the projects (git repositories) one data root serves

Usage:
  boof-runner project add <dir> [--id <kebab>] [--name <text>] [--default] [--brief <text>|--brief-file <file>] [-d <data>]
  boof-runner project add <dir> --new [--confirm] --brief <text>|--brief-file <file> [--id] [--name] [--default] [-d <data>]
  boof-runner project add --auto --brief <text>|--brief-file <file> [--name <text>] [--id] [--default] [-d <data>]
  boof-runner project list [--json] [-d <data>]
  boof-runner project remove <id> [--purge] [-d <data>]

add     Register a git repository (the default), create one at <dir> (--new: mkdir, git init, an
        empty first commit; a non-empty directory needs --confirm) or let boof create
        <settings.projectsRoot>/<id> (--auto, default ~/boof-projects). --brief (or --brief-file)
        explains the project to the agents; required with --new and --auto. The id defaults to the
        directory name. --default makes it the project the legacy /api/tasks routes and
        run/scan without --project use.
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
        new: { type: "boolean" },
        auto: { type: "boolean" },
        confirm: { type: "boolean" },
        brief: { type: "string" },
        "brief-file": { type: "string" },
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
  const projects = new ProjectStore(root, { isGitRepo, repoCommonDir, initGitRepo });
  const settings = new SettingsStore(root);

  try {
    switch (sub) {
      case "add": {
        const dir = positionals[0];
        if (values.new && values.auto) {
          err("project add: --new and --auto exclude each other");
          return 1;
        }
        if (values.auto && dir) {
          err("project add: --auto takes no directory");
          return 1;
        }
        if (!values.auto && !dir) {
          err("project add: a repository directory is required");
          return 1;
        }
        const creating = Boolean(values.new || values.auto);
        let brief = values.brief;
        if (values["brief-file"] !== undefined) {
          try {
            brief = await readFile(resolve(process.cwd(), values["brief-file"]), "utf8");
          } catch (e) {
            err(`project add: ${(e as Error).message}`);
            return 1;
          }
        }
        if (creating && !brief?.trim()) {
          err("project add: --brief or --brief-file is required with --new and --auto");
          return 1;
        }
        const audit = beginCliAudit(root, "cli:project.add");
        try {
          const project = await projects.create({
            ...(values.auto
              ? {
                  path: {
                    mode: "auto" as const,
                    projectsRoot: resolveProjectsRoot(await settings.load()),
                  },
                }
              : {
                  workingDirectory: isAbsolute(dir!) ? dir! : resolve(process.cwd(), dir!),
                  ...(values.new
                    ? { path: { mode: "new" as const, confirm: values.confirm } }
                    : {}),
                }),
            ...(brief ? { brief } : {}),
            ...(values.id ? { id: values.id } : {}),
            ...(values.name ? { name: values.name } : {}),
            origin: { kind: "cli" },
          });
          await pruneStaleWorktrees(project.workingDirectory).catch((err) =>
            console.error(`could not prune worktrees of project ${project.id}:`, err),
          );
          if (values.default) await settings.update({ defaultProject: project.id });
          out(
            `${creating ? "Created" : "Added"} project '${project.id}' (${project.workingDirectory})`,
          );
          if (values.default) out(`'${project.id}' is now the default project`);
          await audit.ok(project.id);
          return 0;
        } catch (e) {
          await audit.fail(e);
          throw e;
        }
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
        const audit = beginCliAudit(root, "cli:project.remove");
        try {
          await projects.remove(id, { purge: values.purge });
          if (values.purge && (await settings.load()).defaultProject === id) {
            await settings.update({ defaultProject: null });
          }
          out(values.purge ? `Purged project '${id}'` : `Archived project '${id}'`);
          await audit.ok(id);
          return 0;
        } catch (e) {
          await audit.fail(e);
          throw e;
        }
      }
      default:
        err(`project: unknown subcommand "${sub}"\n`);
        err(PROJECT_HELP);
        return 1;
    }
  } catch (e) {
    if (e instanceof ProjectError || e instanceof InvalidIdError) {
      const hint =
        sub === "add" && values.new && e instanceof ProjectError && e.code === "directory_not_empty"
          ? " (re-run with --confirm)"
          : "";
      err(`project ${sub}: ${e.message}${hint}`);
      return 1;
    }
    throw e;
  }
}
