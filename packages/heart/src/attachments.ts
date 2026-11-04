import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { taskAssetPath, taskAssetsDir } from "./paths.js";

/** Attachment kinds the prompt box accepts: raster images and PDFs. */
export const ALLOWED_ATTACHMENT_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

/** Largest single attachment we accept (25 MB) — keeps task dirs sane. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function isAllowedAttachmentType(type: string): boolean {
  return ALLOWED_ATTACHMENT_TYPES.has(type);
}

/**
 * Reduce an uploaded filename to a safe basename: no directory components, only
 * a conservative character set, and a non-empty fallback. Prevents path
 * traversal when the name is later joined onto the asset directory.
 */
export function safeAttachmentName(raw: string): string {
  const base = basename(raw)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "");
  return base.length > 0 ? base.slice(0, 120) : "file";
}

/**
 * File-backed store for a task's attachments. Bytes live under
 * tasks/assets/<id>/; the authoritative list is the task frontmatter, which the
 * service keeps in sync. All names are sanitized and de-duplicated.
 */
export class AttachmentStore {
  constructor(private readonly root: string) {}

  dir(id: string): string {
    return taskAssetsDir(this.root, id);
  }

  path(id: string, name: string): string {
    return taskAssetPath(this.root, id, safeAttachmentName(name));
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }

  /** Pick a sanitized name that does not collide with an existing file. */
  private async uniqueName(id: string, desired: string): Promise<string> {
    const safe = safeAttachmentName(desired);
    if (!(await this.exists(taskAssetPath(this.root, id, safe)))) return safe;
    const ext = extname(safe);
    const stem = ext ? safe.slice(0, -ext.length) : safe;
    for (let i = 1; i < 1000; i += 1) {
      const candidate = `${stem}-${i}${ext}`;
      if (!(await this.exists(taskAssetPath(this.root, id, candidate)))) return candidate;
    }
    return `${stem}-${Date.now()}${ext}`;
  }

  /** Write bytes under a unique, sanitized name; returns the stored name. */
  async write(id: string, desiredName: string, bytes: Uint8Array): Promise<string> {
    const dir = this.dir(id);
    await mkdir(dir, { recursive: true });
    const name = await this.uniqueName(id, desiredName);
    await writeFile(taskAssetPath(this.root, id, name), bytes);
    return name;
  }

  async read(id: string, name: string): Promise<Buffer> {
    return readFile(this.path(id, name));
  }

  async remove(id: string, name: string): Promise<void> {
    await rm(this.path(id, name), { force: true });
  }

  /** Remove the whole asset directory for a task (e.g. on cleanup). */
  async removeAll(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
  }

  async listFiles(id: string): Promise<string[]> {
    try {
      const entries = await readdir(this.dir(id), { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return [];
    }
  }
}
