import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BOOF_VERSION } from "./version.js";
import { PRIVATE_SUBDIRS, tightenDataRoot, UnsafeSecretPathError } from "./data-root-mode.js";
import { isInsidePath } from "./project-path.js";
import { dataRootPaths, isKebabId, STATUS_DIRS } from "./paths.js";
import {
  migrateDataRoot,
  MigrationError,
  withMigrationLock,
  type MigrateOptions,
} from "./migrate.js";
import { inspectProcessLock, withProcessLock, type ProcessLockOptions } from "./process-lock.js";
import { resolveWorktreeRoot } from "./settings.js";
import { SETTINGS_SCHEMA_VERSION } from "./schema.js";
import { readTarGz, writeTarGz, TarError, type ArchiveMember, type TarMember } from "./tar-gz.js";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const COPY_CHUNK = 1024 * 1024;

/** Backup or restore refused the archive or the directory. */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

export interface BackupOptions {
  /** Copy while a runner or server holds the root. Task files are taken under their task locks. */
  live?: boolean;
  /** Leave out `auth/`, `external-runs/` and every `secrets.json`. */
  noSecrets?: boolean;
  /** Liveness and wait used for the migration lock and, with `--live`, task locks. */
  lock?: MigrateOptions;
  /** Called once the migration lock is held, before files are copied. */
  onLocked?: () => void | Promise<void>;
}

export interface BackupResult {
  files: number;
  bytes: number;
  schemaVersion: number | null;
  /** Symlinks and special files that were left out, each a short phrase. */
  skipped: string[];
}

export interface RestoreResult {
  files: number;
  /** Schema of the published root after migration. Null when settings.json is still absent. */
  schemaVersion: number | null;
  migrated: boolean;
}

interface Entry {
  rel: string;
  kind: "file" | "dir";
  abs: string;
  /** Task lock relative to the data root. Set only for `--live`. */
  lockRel?: string;
}

interface Staged {
  rel: string;
  kind: "file" | "dir";
  mode: number;
  size: number;
  sha256?: string;
}

interface ManifestFile {
  path: string;
  sha256: string;
  mode: number;
}

interface Manifest {
  format: 1;
  boofVersion: string;
  schemaVersion: number | null;
  files: ManifestFile[];
}

interface LooseSettings {
  schemaVersion: number | null;
  worktreeRoot?: string;
}

const FLAT_STATUS = new Set(Object.values(STATUS_DIRS).filter((dir) => dir !== "ongoing"));

/**
 * Copy `root` to a new gzip ustar archive at `outFile` (mode 0600).
 * The migration lock is held for the whole copy. A live runner (`.runner.pid`) or server
 * (`webhooks/.dispatcher.lock`) refuses the copy unless `live` is set; then each task's files
 * are copied under that task's lock. Worktrees, lock files and symlinks are not stored.
 */
export async function backupDataRoot(
  rootArg: string,
  outArg: string,
  opts: BackupOptions = {},
): Promise<BackupResult> {
  const root = resolve(rootArg);
  const outFile = resolve(outArg);
  const live = opts.live === true;
  const noSecrets = opts.noSecrets === true;
  const lock: ProcessLockOptions = opts.lock ?? {};

  const rootReal = await existingRoot(root);
  await refuseOut(rootReal, outFile);

  const stage = await mkdtempPrivate(join(tmpdir(), "boof-backup-"));
  try {
    if (isInsidePath(rootReal, stage)) {
      throw new BackupError(
        "the temporary directory is inside the data root; set TMPDIR outside it",
      );
    }
    return await withMigrationLock(rootReal, lock, async () => {
      const holders = await liveHolders(rootReal, lock);
      if (holders.length > 0 && !live) {
        const verb = holders.length > 1 ? "hold" : "holds";
        throw new BackupError(
          `${holders.join(" and ")} ${verb} ${rootReal}; pass --live to back up while it runs, or stop it first`,
        );
      }
      if (opts.onLocked) await opts.onLocked();
      const settings = await readSettingsFile(join(rootReal, "settings.json"));
      const skipped: string[] = [];
      const worktrees = await worktreeDirs(rootReal, settings);
      const entries = await collect(rootReal, { noSecrets, live, skipped, worktrees });
      await copyEntries(rootReal, stage, entries, lock);
      const staged = await walkStage(stage);
      const schema = await readSettingsFile(join(stage, "settings.json"));
      const schemaVersion = schema?.schemaVersion ?? null;
      const files = staged.filter((entry) => entry.kind === "file");
      const manifest: Manifest = {
        format: 1,
        boofVersion: BOOF_VERSION,
        schemaVersion,
        files: files
          .map((entry) => ({
            path: entry.rel,
            sha256: entry.sha256 ?? "",
            mode: entry.mode & 0o777,
          }))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      };
      await writeArchive(outFile, stage, staged, manifest);
      const bytes = files.reduce((sum, entry) => sum + entry.size, 0);
      return { files: files.length, bytes, schemaVersion, skipped };
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/**
 * Restore `archive` into `dest`, which must be missing or an empty directory.
 * Every entry is checked before publish: a symlink, a hard link, a path that escapes
 * `dest` and a hash that does not match the manifest are refused. A newer schema is
 * refused. An older one is migrated, then directory and secret modes are set.
 */
export async function restoreDataRoot(archiveArg: string, destArg: string): Promise<RestoreResult> {
  const archive = resolve(archiveArg);
  const dest = resolve(destArg);
  await existingArchive(archive);
  await destKind(dest);

  const parent = dirname(dest);
  const temp = await mkdtempPrivate(join(parent, ".boof-restore-"));
  let published = false;
  try {
    const extracted = new Map<string, string>();
    const seen = new Set<string>();
    let manifestBuf: Buffer | undefined;
    await readTarGz(archive, async (member) => {
      await takeMember(temp, member, extracted, seen, (buf) => {
        if (manifestBuf) throw new BackupError("archive lists manifest.json more than once");
        manifestBuf = buf;
      });
    });
    if (!manifestBuf) throw new BackupError("archive manifest is not a boof backup");
    const manifest = parseManifest(manifestBuf);
    checkTree(manifest, extracted);
    await applyModes(temp, manifest);
    const fileSchema = await schemaOf(join(temp, "settings.json"));
    assertSchema(manifest.schemaVersion, fileSchema);
    const before = fileSchema === "missing" ? null : fileSchema;
    const migrated = before !== SETTINGS_SCHEMA_VERSION;
    if (migrated) await migrateDataRoot(temp);
    await tightenDataRoot(temp);
    await forceSecretModes(temp);
    await publish(temp, dest);
    published = true;
    const after = await schemaOf(join(dest, "settings.json"));
    return {
      files: manifest.files.length,
      schemaVersion: after === "missing" ? null : after,
      migrated,
    };
  } catch (err) {
    throw asBackup(err);
  } finally {
    if (!published) await rm(temp, { recursive: true, force: true });
  }
}

async function existingRoot(root: string): Promise<string> {
  let seen;
  try {
    seen = await lstat(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BackupError(`no data root at ${root}`);
    }
    throw asBackup(err);
  }
  const real = seen.isSymbolicLink() ? await realpath(root) : root;
  const st = await stat(real);
  if (!st.isDirectory()) throw new BackupError(`no data root at ${root}`);
  return real;
}

async function refuseOut(rootReal: string, outFile: string): Promise<void> {
  try {
    await lstat(outFile);
    throw new BackupError(`refusing to overwrite ${outFile}`);
  } catch (err) {
    if (err instanceof BackupError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw asBackup(err);
  }
  const parent = dirname(outFile);
  let parentStat;
  try {
    parentStat = await stat(parent);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BackupError(`the output directory does not exist (${parent})`);
    }
    throw asBackup(err);
  }
  if (!parentStat.isDirectory()) {
    throw new BackupError(`the output directory does not exist (${parent})`);
  }
  const parentReal = await realpath(parent);
  const landed = join(parentReal, basename(outFile));
  if (isInsidePath(rootReal, outFile) || isInsidePath(rootReal, landed)) {
    throw new BackupError("--out is inside the data root");
  }
}

async function liveHolders(root: string, lock: ProcessLockOptions): Promise<string[]> {
  const held: string[] = [];
  const runner = await inspectProcessLock(dataRootPaths(root).runnerPid, lock);
  if (runner.held) held.push(`a runner (pid ${runner.pid})`);
  const server = await inspectProcessLock(
    join(dataRootPaths(root).webhooks, ".dispatcher.lock"),
    lock,
  );
  if (server.held) held.push(`a server (pid ${server.pid})`);
  return held;
}

async function collect(
  root: string,
  ctx: { noSecrets: boolean; live: boolean; skipped: string[]; worktrees: string[] },
): Promise<Entry[]> {
  const entries: Entry[] = [];
  const walk = async (absDir: string, rel: string): Promise<void> => {
    const names = (await readdir(absDir)).sort();
    for (const name of names) {
      assertSafeName(name, rel);
      const childRel = rel ? `${rel}/${name}` : name;
      if (omitted(childRel, name, ctx.noSecrets)) continue;
      const abs = join(absDir, name);
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        ctx.skipped.push(`symbolic link ${childRel}`);
        continue;
      }
      if (st.isDirectory()) {
        if (await underWorktree(abs, ctx.worktrees)) continue;
        entries.push({ rel: childRel, kind: "dir", abs });
        await walk(abs, childRel);
        continue;
      }
      if (!st.isFile()) {
        ctx.skipped.push(`special file ${childRel}`);
        continue;
      }
      const lockRel = ctx.live ? taskLockRel(childRel) : undefined;
      entries.push({ rel: childRel, kind: "file", abs, ...(lockRel ? { lockRel } : {}) });
    }
  };
  await walk(root, "");
  return entries;
}

function omitted(rel: string, name: string, noSecrets: boolean): boolean {
  if (
    noSecrets &&
    (rel === "auth" ||
      rel.startsWith("auth/") ||
      rel === "external-runs" ||
      rel.startsWith("external-runs/"))
  ) {
    return true;
  }
  if (noSecrets && name === "secrets.json") return true;
  if (name === ".locks" || rel.split("/").includes(".locks")) return true;
  if (name === ".runner.pid" || name === ".migration.lock") return true;
  if (name === ".lock" || (name.startsWith(".") && name.endsWith(".lock"))) return true;
  if (name.endsWith(".lock.takeover")) return true;
  if (name === ".boof-runner-worktrees" || rel.split("/").includes(".boof-runner-worktrees")) {
    return true;
  }
  return false;
}

function assertSafeName(name: string, parentRel: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.includes("\r") ||
    name.includes("\n")
  ) {
    const rel = parentRel ? `${parentRel}/${name}` : name;
    throw new BackupError(`cannot back up ${rel}: the file name is not safe to store`);
  }
}

/** v2 `projects/<id>/tasks/...` and v1 `tasks/...`. Undefined when the path is not one task's bytes. */
function taskLockRel(rel: string): string | undefined {
  const parts = rel.split("/");
  let base: string[];
  let rest: string[];
  if (
    parts[0] === "projects" &&
    parts.length >= 4 &&
    parts[2] === "tasks" &&
    isKebabId(parts[1]!)
  ) {
    base = parts.slice(0, 3);
    rest = parts.slice(3);
  } else if (parts[0] === "tasks" && parts.length >= 2) {
    base = ["tasks"];
    rest = parts.slice(1);
  } else {
    return undefined;
  }
  const status = rest[0];
  if (!status || status === ".locks") return undefined;
  let taskId: string | undefined;
  if ((status === "ongoing" || status === "assets") && rest.length >= 2 && isKebabId(rest[1]!)) {
    taskId = rest[1];
  } else if (FLAT_STATUS.has(status) && rest.length === 2 && rest[1]!.endsWith(".md")) {
    const id = rest[1]!.slice(0, -".md".length);
    if (isKebabId(id)) taskId = id;
  }
  if (!taskId) return undefined;
  return [...base, ".locks", `${taskId}.lock`].join("/");
}

async function copyEntries(
  root: string,
  stage: string,
  entries: Entry[],
  lock: ProcessLockOptions,
): Promise<void> {
  const grouped = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (!entry.lockRel) {
      await copyEntry(entry, stage);
      continue;
    }
    const group = grouped.get(entry.lockRel);
    if (group) group.push(entry);
    else grouped.set(entry.lockRel, [entry]);
  }
  for (const [lockRel, group] of grouped) {
    const label = lockLabel(lockRel);
    await withProcessLock(
      join(root, ...lockRel.split("/")),
      lock,
      async () => {
        for (const entry of group) await copyEntry(entry, stage);
      },
      (holder) => new BackupError(`task ${label} is locked by pid ${holder}`),
    );
  }
}

function lockLabel(lockRel: string): string {
  const parts = lockRel.split("/");
  const file = parts[parts.length - 1] ?? lockRel;
  const id = file.replace(/\.lock$/, "");
  if (parts[0] === "projects" && parts.length >= 2) return `${parts[1]}/${id}`;
  return id;
}

async function copyEntry(entry: Entry, stage: string): Promise<void> {
  const dest = join(stage, ...entry.rel.split("/"));
  if (entry.kind === "dir") {
    try {
      await mkdir(dest, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new BackupError(`cannot back up ${entry.rel}: it changed while archiving`);
      }
      throw err;
    }
    await chmodMode(dest, 0o700);
    return;
  }
  await copyFile(entry.abs, dest, entry.rel);
}

async function copyFile(src: string, dest: string, rel: string): Promise<void> {
  let fh;
  try {
    fh = await open(src, constants.O_RDONLY | NOFOLLOW);
  } catch (err) {
    throw changedOr(err, rel);
  }
  try {
    const before = await fh.stat();
    if (!before.isFile()) {
      throw new BackupError(`cannot back up ${rel}: it changed while archiving`);
    }
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    const out = await open(
      dest,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    try {
      const buf = Buffer.alloc(COPY_CHUNK);
      let left = before.size;
      while (left > 0) {
        const read = await fh.read(buf, 0, Math.min(buf.length, left), null);
        if (read.bytesRead === 0) break;
        let off = 0;
        while (off < read.bytesRead) {
          const wrote = await out.write(buf.subarray(off, read.bytesRead));
          if (wrote.bytesWritten <= 0) {
            throw new BackupError(`cannot back up ${rel}: it changed while archiving`);
          }
          off += wrote.bytesWritten;
        }
        left -= read.bytesRead;
      }
      if (left !== 0) throw new BackupError(`cannot back up ${rel}: it changed while archiving`);
      const after = await fh.stat();
      if (!after.isFile() || after.size !== before.size) {
        throw new BackupError(`cannot back up ${rel}: it changed while archiving`);
      }
    } finally {
      await out.close();
    }
    const mode = before.mode & 0o777 || 0o600;
    await chmodMode(dest, mode);
  } finally {
    await fh.close();
  }
}

function changedOr(err: unknown, rel: string): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ELOOP" || code === "ENOENT") {
    return new BackupError(`cannot back up ${rel}: it changed while archiving`);
  }
  return err instanceof Error ? err : new BackupError(String(err));
}

async function walkStage(stage: string): Promise<Staged[]> {
  const out: Staged[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const abs = join(dir, name);
      const child = rel ? `${rel}/${name}` : name;
      const st = await lstat(abs);
      if (st.isDirectory()) {
        out.push({ rel: child, kind: "dir", mode: 0o700, size: 0 });
        await walk(abs, child);
        continue;
      }
      if (!st.isFile()) {
        throw new BackupError(`cannot back up ${child}: it changed while archiving`);
      }
      const hashed = await sha256File(abs);
      out.push({
        rel: child,
        kind: "file",
        mode: st.mode & 0o777 || 0o600,
        size: hashed.bytes,
        sha256: hashed.hex,
      });
    }
  };
  await walk(stage, "");
  return out;
}

async function sha256File(path: string): Promise<{ hex: string; bytes: number }> {
  const fh = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const hash = createHash("sha256");
    const buf = Buffer.alloc(COPY_CHUNK);
    let bytes = 0;
    for (;;) {
      const read = await fh.read(buf, 0, buf.length, null);
      if (read.bytesRead === 0) break;
      hash.update(buf.subarray(0, read.bytesRead));
      bytes += read.bytesRead;
    }
    return { hex: hash.digest("hex"), bytes };
  } finally {
    await fh.close();
  }
}

async function writeArchive(
  outFile: string,
  stage: string,
  staged: Staged[],
  manifest: Manifest,
): Promise<void> {
  const ordered = [...staged].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const members: ArchiveMember[] = [
    {
      path: "manifest.json",
      kind: "file",
      mode: 0o600,
      body: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"),
    },
    { path: "root", kind: "dir", mode: 0o700 },
    ...ordered.map((entry): ArchiveMember =>
      entry.kind === "dir"
        ? { path: `root/${entry.rel}`, kind: "dir", mode: 0o700 }
        : {
            path: `root/${entry.rel}`,
            kind: "file",
            mode: entry.mode,
            source: join(stage, ...entry.rel.split("/")),
          },
    ),
  ];
  try {
    await writeTarGz(outFile, members);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("EEXIST") || message.includes("already exists")) {
      throw new BackupError(`refusing to overwrite ${outFile}`);
    }
    throw asBackup(err);
  }
}

async function existingArchive(archive: string): Promise<void> {
  let st;
  try {
    st = await lstat(archive);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BackupError(`no archive at ${archive}`);
    }
    throw asBackup(err);
  }
  if (st.isSymbolicLink())
    throw new BackupError("refusing to read an archive that is a symbolic link");
  if (!st.isFile()) throw new BackupError("archive is not a regular file");
}

type DestKind = "missing" | "empty";

async function destKind(dest: string): Promise<DestKind> {
  let st;
  try {
    st = await lstat(dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw asBackup(err);
    const parent = dirname(dest);
    let parentStat;
    try {
      parentStat = await lstat(parent);
    } catch (parentErr) {
      if ((parentErr as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BackupError(`the destination's parent does not exist (${parent})`);
      }
      throw asBackup(parentErr);
    }
    if (parentStat.isSymbolicLink()) {
      throw new BackupError("the destination's parent is a symbolic link");
    }
    if (!parentStat.isDirectory()) {
      throw new BackupError(`the destination's parent does not exist (${parent})`);
    }
    return "missing";
  }
  if (st.isSymbolicLink()) throw new BackupError("refusing to restore into a symbolic link");
  if (!st.isDirectory()) throw new BackupError(`${dest} is not a directory`);
  const names = await readdir(dest);
  if (names.length > 0) throw new BackupError(`${dest} is not empty`);
  return "empty";
}

async function takeMember(
  temp: string,
  member: TarMember,
  extracted: Map<string, string>,
  seen: Set<string>,
  takeManifest: (buf: Buffer) => void,
): Promise<void> {
  if (member.kind === "symlink") {
    throw new BackupError(
      `archive contains a symbolic link (${member.path}); refusing to restore it`,
    );
  }
  if (member.kind === "hardlink") {
    throw new BackupError(`archive contains a hard link (${member.path}); refusing to restore it`);
  }
  if (member.kind === "other") {
    throw new BackupError(`archive contains an unsupported entry (${member.path})`);
  }
  const role = classify(member.path);
  if (role === "manifest") {
    if (member.kind !== "file" || !member.read) {
      throw new BackupError("archive manifest is not a boof backup");
    }
    takeManifest(await member.read());
    return;
  }
  if (role === "root") {
    if (member.kind !== "dir") throw new BackupError("archive path escapes the data root (root)");
    return;
  }
  const rel = role.rel;
  if (!isSafeRel(rel)) throw new BackupError(`archive path escapes the data root (${member.path})`);
  if (seen.has(rel)) throw new BackupError(`archive lists ${rel} more than once`);
  seen.add(rel);
  const target = inside(temp, rel, member.path);
  if (member.kind === "dir") {
    await mkdir(target, { recursive: true, mode: 0o700 });
    await chmodMode(target, 0o700);
    return;
  }
  if (!member.copyTo)
    throw new BackupError(`archive contains an unsupported entry (${member.path})`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const sha = await member.copyTo(target);
  extracted.set(rel, sha);
}

function classify(path: string): "manifest" | "root" | { rel: string } {
  let trimmed = path;
  if (trimmed.endsWith("/") && trimmed.length > 1) trimmed = trimmed.slice(0, -1);
  if (trimmed === "manifest.json") return "manifest";
  if (trimmed === "root") return "root";
  if (trimmed.startsWith("root/")) {
    const rel = trimmed.slice("root/".length);
    if (!isSafeRel(rel)) throw new BackupError(`archive path escapes the data root (${path})`);
    return { rel };
  }
  throw new BackupError(`archive path escapes the data root (${path})`);
}

function isSafeRel(rel: string): boolean {
  if (rel.length === 0 || rel.length > 4096) return false;
  if (rel.includes("\0") || rel.includes("\\") || rel.includes("\r") || rel.includes("\n")) {
    return false;
  }
  if (rel.startsWith("/")) return false;
  for (const part of rel.split("/")) {
    if (part === "" || part === "." || part === "..") return false;
    if (/^[A-Za-z]:/.test(part)) return false;
  }
  return true;
}

function inside(temp: string, rel: string, shown: string): string {
  const target = join(temp, ...rel.split("/"));
  const relTo = relative(temp, target);
  if (relTo === "" || relTo === ".." || relTo.startsWith(`..${sep}`) || isAbsolute(relTo)) {
    throw new BackupError(`archive path escapes the data root (${shown})`);
  }
  return target;
}

function parseManifest(buf: Buffer): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new BackupError("archive manifest is not a boof backup");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BackupError("archive manifest is not a boof backup");
  }
  const rec = raw as Record<string, unknown>;
  if (rec.format !== 1 || typeof rec.boofVersion !== "string" || rec.boofVersion.length === 0) {
    throw new BackupError("archive manifest is not a boof backup");
  }
  if (!Array.isArray(rec.files)) throw new BackupError("archive manifest is not a boof backup");
  const schemaVersion = rec.schemaVersion;
  if (!(
    schemaVersion === null ||
    (typeof schemaVersion === "number" && Number.isInteger(schemaVersion) && schemaVersion >= 0)
  )) {
    throw new BackupError("archive manifest is not a boof backup");
  }
  const files: ManifestFile[] = [];
  const seen = new Set<string>();
  for (const item of rec.files) {
    if (!item || typeof item !== "object") {
      throw new BackupError("archive manifest is not a boof backup");
    }
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || !isSafeRel(file.path)) {
      throw new BackupError(`archive path escapes the data root (${String(file.path)})`);
    }
    if (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new BackupError("archive manifest is not a boof backup");
    }
    if (
      typeof file.mode !== "number" ||
      !Number.isInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o777
    ) {
      throw new BackupError("archive manifest is not a boof backup");
    }
    if (seen.has(file.path)) throw new BackupError(`archive lists ${file.path} more than once`);
    seen.add(file.path);
    files.push({ path: file.path, sha256: file.sha256, mode: file.mode });
  }
  return { format: 1, boofVersion: rec.boofVersion, schemaVersion, files };
}

function checkTree(manifest: Manifest, extracted: Map<string, string>): void {
  const listed = new Set(manifest.files.map((file) => file.path));
  for (const file of manifest.files) {
    const got = extracted.get(file.path);
    if (got === undefined) throw new BackupError(`archive is missing ${file.path}`);
    if (got !== file.sha256) {
      throw new BackupError(`sha256 of ${file.path} does not match the manifest`);
    }
  }
  for (const path of extracted.keys()) {
    if (!listed.has(path)) throw new BackupError(`archive has an extra file ${path}`);
  }
}

async function applyModes(temp: string, manifest: Manifest): Promise<void> {
  for (const file of manifest.files) {
    const mode = secretRel(file.path) ? 0o600 : file.mode & 0o777 || 0o600;
    await chmodMode(join(temp, ...file.path.split("/")), mode);
  }
}

function secretRel(rel: string): boolean {
  if (rel.startsWith("auth/") || rel.startsWith("external-runs/")) return true;
  if (rel === "secrets.json" || rel.endsWith("/secrets.json")) return true;
  if (rel === "n8n/workflows.json" || rel === "n8n/seen.json") return true;
  if (rel.startsWith("owlish/") || rel.startsWith("concierge/")) return true;
  return false;
}

async function forceSecretModes(root: string): Promise<void> {
  const walk = async (dir: string, rel: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const child = rel ? `${rel}/${name}` : name;
      const abs = join(dir, name);
      const st = await lstat(abs);
      if (st.isDirectory()) {
        if ((PRIVATE_SUBDIRS as readonly string[]).includes(name) && rel === "") {
          await chmodMode(abs, 0o700);
        }
        await walk(abs, child);
        continue;
      }
      if (st.isFile() && secretRel(child)) await chmodMode(abs, 0o600);
    }
  };
  await chmodMode(root, 0o700);
  await walk(root, "");
}

type FileSchema = number | null | "missing";

async function schemaOf(file: string): Promise<FileSchema> {
  const loose = await readSettingsFile(file);
  if (!loose) return "missing";
  return loose.schemaVersion;
}

function assertSchema(manifestSchema: number | null, fileSchema: FileSchema): void {
  const fromFile = fileSchema === "missing" ? null : fileSchema;
  const newer = [manifestSchema, fromFile].find(
    (n): n is number => n !== null && n > SETTINGS_SCHEMA_VERSION,
  );
  if (newer !== undefined) {
    throw new BackupError(
      `schemaVersion ${newer} is newer than this boof-runner supports (${SETTINGS_SCHEMA_VERSION}); upgrade boof-runner`,
    );
  }
  if (fileSchema === "missing") {
    if (manifestSchema !== null) {
      throw new BackupError("archive manifest schema does not match settings.json");
    }
    return;
  }
  if (fromFile !== manifestSchema) {
    throw new BackupError("archive manifest schema does not match settings.json");
  }
}

async function publish(temp: string, dest: string): Promise<void> {
  const now = await destKind(dest);
  if (now === "missing") {
    await rename(temp, dest);
    return;
  }
  try {
    await rmdir(dest);
  } catch {
    throw new BackupError(`${dest} is not empty`);
  }
  try {
    await rename(temp, dest);
  } catch (err) {
    await mkdir(dest, { mode: 0o700 }).catch(() => undefined);
    throw err;
  }
}

async function readSettingsFile(file: string): Promise<LooseSettings | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new BackupError(`cannot read settings.json: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BackupError("settings.json is not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BackupError("settings.json is not an object");
  }
  const rec = raw as Record<string, unknown>;
  let schemaVersion: number | null = null;
  if ("schemaVersion" in rec && rec.schemaVersion !== undefined) {
    if (typeof rec.schemaVersion !== "number" || !Number.isInteger(rec.schemaVersion)) {
      throw new BackupError("settings.json schemaVersion is not an integer");
    }
    schemaVersion = rec.schemaVersion;
  }
  let worktreeRoot: string | undefined;
  const worktree = rec.worktree;
  if (worktree && typeof worktree === "object" && !Array.isArray(worktree)) {
    const root = (worktree as { root?: unknown }).root;
    if (typeof root === "string" && root.length > 0) worktreeRoot = root;
  }
  return { schemaVersion, ...(worktreeRoot ? { worktreeRoot } : {}) };
}

async function worktreeDirs(rootReal: string, settings: LooseSettings | null): Promise<string[]> {
  const globalRoot = settings?.worktreeRoot;
  const found = new Set<string>();
  const add = async (abs: string): Promise<void> => {
    let real = abs;
    try {
      real = await realpath(abs);
    } catch {
      // The directory is not there. A lexical path still excludes it if it appears later.
    }
    if (properChild(rootReal, real) || properChild(rootReal, abs)) found.add(real);
  };
  if (globalRoot && (globalRoot === "~" || globalRoot.startsWith("~/") || isAbsolute(globalRoot))) {
    await add(resolveWorktreeRoot({ root: globalRoot }, rootReal));
  }
  let projects: string[] = [];
  try {
    projects = await readdir(join(rootReal, "projects"));
  } catch {
    projects = [];
  }
  for (const id of projects) {
    if (!isKebabId(id)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(rootReal, "projects", id, "project.json"), "utf8"));
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const project = raw as { workingDirectory?: unknown; worktree?: unknown };
    if (typeof project.workingDirectory !== "string" || project.workingDirectory.length === 0) {
      continue;
    }
    let own: string | undefined;
    if (
      project.worktree &&
      typeof project.worktree === "object" &&
      !Array.isArray(project.worktree)
    ) {
      const root = (project.worktree as { root?: unknown }).root;
      if (typeof root === "string" && root.length > 0) own = root;
    }
    const chosen = own ?? globalRoot;
    await add(resolveWorktreeRoot({ root: chosen }, project.workingDirectory));
  }
  return [...found];
}

function properChild(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function underWorktree(abs: string, roots: string[]): Promise<boolean> {
  if (roots.length === 0) return false;
  const real = await realpath(abs).catch(() => abs);
  return roots.some((root) => isInsidePath(root, abs) || isInsidePath(root, real));
}

async function mkdtempPrivate(prefix: string): Promise<string> {
  const dir = await mkdtemp(prefix);
  await chmodMode(dir, 0o700);
  return dir;
}

async function chmodMode(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      process.platform === "win32" &&
      (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP")
    ) {
      return;
    }
    throw err;
  }
}

function asBackup(err: unknown): Error {
  if (
    err instanceof BackupError ||
    err instanceof MigrationError ||
    err instanceof UnsafeSecretPathError
  ) {
    return err;
  }
  if (err instanceof TarError) return new BackupError(err.message);
  const message = err instanceof Error ? err.message : String(err);
  return new BackupError(message);
}
