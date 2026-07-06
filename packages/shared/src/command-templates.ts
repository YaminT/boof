import matter from "gray-matter";
import { readdir, rm, stat } from "node:fs/promises";
import { lockedAtomicWrite, readText } from "./atomic.js";
import { toKebabId } from "./ids.js";
import { commandFilePath, dataPaths } from "./paths.js";
import { CommandTemplateFrontmatterSchema } from "./schema.js";
import type { Task } from "./task-file.js";

export interface CommandTemplate {
  id: string;
  name: string;
  body: string;
}

export function parseCommandTemplate(raw: string): CommandTemplate {
  const parsed = matter(raw);
  const fm = CommandTemplateFrontmatterSchema.parse(parsed.data);
  return { id: fm.id, name: fm.name, body: parsed.content.trim() };
}

export function serializeCommandTemplate(tpl: CommandTemplate): string {
  return matter.stringify("\n" + tpl.body.trim() + "\n", { id: tpl.id, name: tpl.name });
}

/**
 * Inject a command template into a task: set the frontmatter `command` field to
 * the template id and replace the `## Command` body with the template body
 * verbatim. Passing `null` clears both (command-templates spec).
 */
export function injectCommand(task: Task, tpl: CommandTemplate | null): Task {
  if (!tpl) {
    task.frontmatter.command = null;
    task.body.command = "";
  } else {
    task.frontmatter.command = tpl.id;
    task.body.command = tpl.body;
  }
  return task;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** File-backed command-template repository under <root>/commands/. */
export class CommandStore {
  constructor(private readonly root: string) {}

  async list(): Promise<CommandTemplate[]> {
    let names: string[] = [];
    try {
      const entries = await readdir(dataPaths(this.root).commands, { withFileTypes: true });
      names = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
    } catch {
      names = [];
    }
    const out: CommandTemplate[] = [];
    for (const name of names) {
      out.push(parseCommandTemplate(await readText(commandFilePath(this.root, name.slice(0, -3)))));
    }
    return out;
  }

  async get(id: string): Promise<CommandTemplate | null> {
    const p = commandFilePath(this.root, id);
    if (!(await exists(p))) return null;
    return parseCommandTemplate(await readText(p));
  }

  /** Create or update a template. The id is auto-derived from the name. */
  async upsert(name: string, body: string): Promise<CommandTemplate> {
    const id = toKebabId(name) || "command";
    const tpl: CommandTemplate = { id, name, body };
    await lockedAtomicWrite(commandFilePath(this.root, id), serializeCommandTemplate(tpl));
    return tpl;
  }

  async delete(id: string): Promise<void> {
    await rm(commandFilePath(this.root, id), { force: true });
  }
}
