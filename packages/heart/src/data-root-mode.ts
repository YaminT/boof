import { chmod, lstat, open, readlink, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export const PRIVATE_SUBDIRS = [
  "auth",
  "owlish",
  "webhooks",
  "audit",
  "idempotency",
  "concierge",
  "claude-agent-config",
] as const;

export type TightenResult =
  | { changed: true; before: number }
  | {
      changed: false;
      reason:
        "already-private" | "windows" | "missing" | "not-owner" | "home-or-root" | "chmod-failed";
      mode?: number;
    };

export async function tightenDataRoot(
  root: string,
  opts: { platform?: NodeJS.Platform; uid?: number; home?: string } = {},
): Promise<TightenResult> {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") return { changed: false, reason: "windows" };
  try {
    const rootStat = await stat(root);
    const resolvedRoot = await realpath(root);
    const home = opts.home ?? process.env.HOME;
    if (
      resolvedRoot === "/" ||
      (home && resolvedRoot === (await realpath(home).catch(() => resolve(home))))
    ) {
      return { changed: false, reason: "home-or-root" };
    }
    const uid = opts.uid ?? process.getuid?.();
    if (uid === undefined || rootStat.uid !== uid) return { changed: false, reason: "not-owner" };
    await checkLinkOwners(resolve(root), uid);

    const before = rootStat.mode & 0o777;
    const changed = (before & 0o077) !== 0;
    const rootHandle = await open(
      resolvedRoot,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const handleStat = await rootHandle.stat();
      if (!handleStat.isDirectory() || handleStat.uid !== uid)
        return { changed: false, reason: "not-owner" };
      if (changed) {
        await rootHandle.chmod(0o700);
        const after = await rootHandle.stat();
        if (after.uid !== uid || (after.mode & 0o077) !== 0)
          return { changed: false, reason: "chmod-failed", mode: before };
      }
    } catch {
      return { changed: false, reason: "chmod-failed", mode: before };
    } finally {
      await rootHandle.close();
    }
    for (const name of PRIVATE_SUBDIRS) {
      const path = join(resolvedRoot, name);
      try {
        const entry = await lstat(path);
        if (entry.isSymbolicLink() || !entry.isDirectory() || entry.uid !== uid) continue;
        await chmod(path, 0o700);
      } catch {
        // Tightening is best effort; a later consumer still validates secret paths.
      }
    }
    return changed ? { changed: true, before } : { changed: false, reason: "already-private" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { changed: false, reason: "missing" };
    return { changed: false, reason: "chmod-failed" };
  }
}

export class UnsafeSecretPathError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "UnsafeSecretPathError";
  }
}

type SecretKind = "directory" | "file";

function uidFor(platform: NodeJS.Platform): number | undefined {
  return platform === "win32" ? undefined : process.getuid?.();
}

function fail(path: string, message: string): never {
  throw new UnsafeSecretPathError(path, `${path} ${message}`);
}

async function checkLinkOwners(path: string, uid: number, depth = 0): Promise<void> {
  if (depth > 40) fail(path, "has too many symbolic links; use a real data root");
  const absolute = resolve(path);
  const parsedRoot = isAbsolute(absolute) ? absolute.slice(0, absolute.indexOf(sep) + 1) : "/";
  const parts = absolute.slice(parsedRoot.length).split(sep).filter(Boolean);
  let current = parsedRoot;
  for (const part of parts) {
    const candidate = join(current, part);
    let entry;
    try {
      entry = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (entry.isSymbolicLink()) {
      if (entry.uid !== uid && entry.uid !== 0)
        fail(
          candidate,
          `is a symbolic link owned by uid ${entry.uid}; use a data root owned by your uid or root`,
        );
      const target = resolve(dirname(candidate), await readlink(candidate));
      await checkLinkOwners(target, uid, depth + 1);
      current = target;
    } else {
      current = candidate;
    }
  }
}

async function checkAncestors(rootPath: string): Promise<void> {
  let current = dirname(rootPath);
  while (current !== dirname(current)) {
    const st = await stat(current);
    const mode = st.mode & 0o7777;
    if ((mode & 0o1000) !== 0) return;
    if ((mode & 0o022) !== 0)
      fail(
        current,
        `is a group-writable or world-writable ancestor; move the data root below a root-owned or sticky directory`,
      );
    if (st.uid === 0) return;
    current = dirname(current);
  }
}

/** Validate the root, ancestor chain and requested directory/file before trusting secret data. */
export async function assertSafeForSecrets(
  root: string,
  path: string,
  kind: SecretKind,
  opts: { allowMissing?: boolean; platform?: NodeJS.Platform; uid?: number } = {},
): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const uid = opts.uid ?? uidFor(platform);
  if (platform === "win32" || uid === undefined) return;

  let rootInitial;
  try {
    rootInitial = await stat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && opts.allowMissing) return;
    throw error;
  }
  const home = process.env.HOME;
  const rootReal = await realpath(root);
  await checkLinkOwners(resolve(root), uid);
  await checkAncestors(rootReal);
  if (
    rootInitial.uid === uid &&
    rootReal !== "/" &&
    !(home && rootReal === (await realpath(home).catch(() => resolve(home)))) &&
    (rootInitial.mode & 0o022) !== 0 &&
    (rootInitial.mode & 0o1000) === 0
  ) {
    const rootHandle = await open(
      rootReal,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const handleStat = await rootHandle.stat();
      if (!handleStat.isDirectory() || handleStat.uid !== uid)
        fail(root, "changed while checking; use a data root directory you own");
      try {
        await rootHandle.chmod(handleStat.mode & ~0o022);
      } catch {
        // The final owner/mode check below reports an actionable refusal.
      }
    } finally {
      await rootHandle.close();
    }
  }
  const resolvedRoot = rootReal;
  const rootStat = await stat(root);
  const rootMode = rootStat.mode & 0o7777;
  if (!rootStat.isDirectory()) fail(root, "is not a real directory; use a data root directory");
  if (rootStat.uid !== uid && rootStat.uid !== 0)
    fail(root, `is owned by uid ${rootStat.uid}; use a data root owned by your uid or root`);
  if ((rootMode & 0o022) !== 0 && (rootMode & 0o1000) === 0)
    fail(
      root,
      `is group-writable or world-writable (mode ${(rootMode & 0o777).toString(8)}); run chmod go-w ${root}`,
    );
  const rootHandle = await open(
    resolvedRoot,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const handleStat = await rootHandle.stat();
    if (!handleStat.isDirectory() || (handleStat.uid !== uid && handleStat.uid !== 0))
      fail(
        root,
        "changed while checking; use a real data root directory owned by your uid or root",
      );
  } finally {
    await rootHandle.close();
  }

  const absolutePath = resolve(path);
  const relative =
    absolutePath === resolvedRoot
      ? ""
      : absolutePath.startsWith(`${resolve(root)}${sep}`)
        ? absolutePath.slice(resolve(root).length + 1)
        : absolutePath.startsWith(`${resolvedRoot}${sep}`)
          ? absolutePath.slice(resolvedRoot.length + 1)
          : null;
  if (relative === null)
    fail(path, "is outside the data root; keep secret files inside the data root");
  const resolvedPath = join(resolvedRoot, relative);
  await checkLinkOwners(absolutePath, uid);

  const parent = kind === "file" ? dirname(resolvedPath) : resolvedPath;
  const parentStat = await lstat(parent).catch((error: unknown) => {
    if (opts.allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!parentStat) return;
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
    fail(parent, "is not a real directory; replace it with a directory and run chmod 700");
  if (parentStat.uid !== uid)
    fail(parent, `is owned by uid ${parentStat.uid}; use an auth directory you own`);
  if ((parentStat.mode & 0o022) !== 0)
    fail(
      parent,
      `is group-writable or world-writable (mode ${(parentStat.mode & 0o777).toString(8)}); run chmod 700 ${parent}`,
    );
  const dirHandle = await open(
    parent,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const handleStat = await dirHandle.stat();
    if (!handleStat.isDirectory() || handleStat.uid !== uid || (handleStat.mode & 0o022) !== 0)
      fail(
        parent,
        "changed while checking; replace it with a directory owned by your uid and run chmod 700",
      );
  } finally {
    await dirHandle.close();
  }

  if (kind === "file") {
    let fileStat;
    try {
      fileStat = await lstat(resolvedPath);
    } catch (error) {
      if (opts.allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!fileStat.isFile() || fileStat.isSymbolicLink())
      fail(
        resolvedPath,
        "is not a safe regular file; replace it with a regular file and run chmod 600",
      );
    if (fileStat.uid !== uid)
      fail(
        resolvedPath,
        `is owned by uid ${fileStat.uid}; replace it with a file you own and run chmod 600`,
      );
    if ((fileStat.mode & 0o022) !== 0)
      fail(
        resolvedPath,
        `is group-writable or world-writable (mode ${(fileStat.mode & 0o777).toString(8)}); run chmod 600 ${resolvedPath}`,
      );
    const fileHandle = await open(resolvedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const handleStat = await fileHandle.stat();
      if (!handleStat.isFile() || handleStat.uid !== uid || (handleStat.mode & 0o022) !== 0)
        fail(
          resolvedPath,
          "changed while checking; replace it with a regular file you own and run chmod 600",
        );
    } finally {
      await fileHandle.close();
    }
  }
}
