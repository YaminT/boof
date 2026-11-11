import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Settings } from "./schema.js";

export const DEFAULT_PROJECTS_ROOT = "~/boof-projects";

/** `~` and `~/x` expand to the home directory; anything else is returned unchanged. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Absolute directory where `auto` creates projects; a still-relative value resolves against home. */
export function resolveProjectsRoot(settings: Pick<Settings, "projectsRoot">): string {
  const root = expandHome(settings.projectsRoot ?? DEFAULT_PROJECTS_ROOT);
  return isAbsolute(root) ? root : resolve(homedir(), root);
}

/** True when `child` is `parent` itself or lies below it. */
export function isInsidePath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/**
 * Resolves a path that may not exist yet: realpaths the deepest existing ancestor (following
 * symlinks) and re-joins the missing segments. Never creates anything. `exists` is true when
 * `target` itself exists.
 *
 * `access()` on Windows can succeed for a dangling symlink, and `realpath` then throws ENOENT.
 * Walking on that error (instead of treating access failure as absence) keeps the link in the
 * tail so the caller can refuse it, rather than leaking the ENOENT.
 */
export async function resolveUnbornPath(
  target: string,
): Promise<{ real: string; exists: boolean }> {
  if (!isAbsolute(target)) throw new Error("path must be absolute");
  let dir = resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return { real: join(await realpath(dir), ...tail), exists: tail.length === 0 };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOTDIR: an ancestor is a file. Walk up so the caller can say so, instead of leaking it.
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES" && code !== "EPERM")
        throw err;
    }
    const parent = dirname(dir);
    if (parent === dir) return { real: dir, exists: false };
    tail.unshift(basename(dir));
    dir = parent;
  }
}
