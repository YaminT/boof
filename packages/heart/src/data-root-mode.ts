import { chmod, lstat, open, readFile, readlink, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  aclNeedsTighten,
  isFilesystemRoot,
  parentLetsOthersWrite,
  parentPath,
  windowsAclFromRunner,
  type AclPrincipal,
  type WindowsAclOps,
} from "./windows-acl.js";

export const PRIVATE_SUBDIRS = [
  "auth",
  "owlish",
  "webhooks",
  "audit",
  "idempotency",
  "concierge",
  "claude-agent-config",
  "n8n",
  "external-runs",
] as const;

/** A folder above the data root that others could write to; the root itself may still be private. */
export interface UnsafeParent {
  path: string;
  message: string;
}

export type TightenResult =
  | { changed: true; before: number; unsafeParent?: UnsafeParent }
  | { changed: true; via: "acl"; unsafeParent?: UnsafeParent }
  | {
      changed: false;
      reason: "acl-failed";
      message: string;
      unsafeParent?: UnsafeParent;
    }
  | {
      changed: false;
      reason: "already-private" | "missing" | "not-owner" | "home-or-root" | "chmod-failed";
      mode?: number;
      unsafeParent?: UnsafeParent;
    };

/** Text of /etc/group and /etc/passwd (undefined when unreadable) and the current user name. */
export interface AccountFiles {
  group?: string;
  passwd?: string;
  username?: string;
}

let accountFilesCache: Promise<AccountFiles> | undefined;

async function readAccountFiles(): Promise<AccountFiles> {
  const read = (path: string) => readFile(path, "utf8").catch(() => undefined);
  let username: string | undefined;
  try {
    username = userInfo().username;
  } catch {
    username = undefined;
  }
  return { group: await read("/etc/group"), passwd: await read("/etc/passwd"), username };
}

/** Read once per process. */
function accountFiles(): Promise<AccountFiles> {
  accountFilesCache ??= readAccountFiles();
  return accountFilesCache;
}

/** Test seam: replace (or with `undefined` reset) the cached account files. */
export function setAccountFilesForTests(files: AccountFiles | undefined): void {
  accountFilesCache = files ? Promise.resolve(files) : undefined;
}

/**
 * A user private group, as login.defs/pam_umask define it: the group is named like the user and
 * nobody else belongs to it (no other member, no other account with it as primary group).
 * With no /etc/group entry for the gid (NSS, LDAP), fall back to gid === uid.
 */
export function isUserPrivateGroup(uid: number, gid: number, files: AccountFiles): boolean {
  const entry = (files.group ?? "")
    .split("\n")
    .map((line) => line.split(":"))
    .find((f) => f.length >= 3 && Number(f[2]) === gid);
  if (!entry) return gid === uid;
  const user = files.username;
  if (!user || entry[0] !== user) return false;
  if ((entry[3] ?? "").split(",").some((m) => m.trim() !== "" && m.trim() !== user)) return false;
  for (const line of (files.passwd ?? "").split("\n")) {
    const f = line.split(":");
    if (f.length >= 4 && Number(f[3]) === gid && f[0] !== user) return false;
  }
  return true;
}

interface Check {
  uid: number;
  isPrivate: (gid: number) => boolean;
  lstatFn: typeof lstat;
  statFn: typeof stat;
  /** When set, unsafe ancestors are collected here instead of thrown. */
  collect?: UnsafeSecretPathError[];
}

async function makeCheck(
  uid: number,
  opts: { gid?: number; accounts?: AccountFiles; lstat?: typeof lstat; stat?: typeof stat },
  collect?: UnsafeSecretPathError[],
): Promise<Check> {
  const files = opts.accounts ?? (await accountFiles());
  const ownGid = opts.gid ?? process.getgid?.() ?? -1;
  return {
    uid,
    isPrivate: (gid) => gid === ownGid && isUserPrivateGroup(uid, gid, files),
    lstatFn: opts.lstat ?? lstat,
    statFn: opts.stat ?? stat,
    collect,
  };
}

export async function tightenDataRoot(
  root: string,
  opts: {
    platform?: NodeJS.Platform;
    uid?: number;
    gid?: number;
    home?: string;
    chmod?: typeof chmod;
    accounts?: AccountFiles;
    /** Windows ACL reader and writer. Tests pass a fake; win32 uses icacls. */
    windowsAcl?: WindowsAclOps;
  } = {},
): Promise<TightenResult> {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") return tightenWindows(root, opts);
  try {
    const rootStat = await stat(root);
    const resolvedRoot = await realpath(root);
    const home = opts.home ?? homedir();
    if (
      resolvedRoot === "/" ||
      (home && resolvedRoot === (await realpath(home).catch(() => resolve(home))))
    ) {
      return { changed: false, reason: "home-or-root" };
    }
    const uid = opts.uid ?? process.getuid?.();
    if (uid === undefined || rootStat.uid !== uid) return { changed: false, reason: "not-owner" };
    // Tightening (read safety) goes ahead under an unsafe parent; the parent is reported instead.
    const parentIssues: UnsafeSecretPathError[] = [];
    await checkLinkOwners(resolve(root), await makeCheck(uid, opts, parentIssues));
    const unsafeParent = parentIssues[0]
      ? { path: parentIssues[0].path, message: parentIssues[0].message }
      : undefined;
    const withParent = <T extends object>(r: T): T => (unsafeParent ? { ...r, unsafeParent } : r);

    const before = rootStat.mode & 0o777;
    const changed = (before & 0o077) !== 0;
    const rootHandle = await open(
      resolvedRoot,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    let rootChmodFailed = false;
    try {
      const handleStat = await rootHandle.stat();
      if (!handleStat.isDirectory() || handleStat.uid !== uid)
        return withParent({ changed: false, reason: "not-owner" });
      if (changed) {
        try {
          await rootHandle.chmod(0o700);
          const after = await rootHandle.stat();
          if (after.uid !== uid || (after.mode & 0o077) !== 0) rootChmodFailed = true;
        } catch {
          rootChmodFailed = true;
        }
      }
    } catch {
      rootChmodFailed = true;
    } finally {
      await rootHandle.close();
    }
    for (const name of PRIVATE_SUBDIRS) {
      const path = join(resolvedRoot, name);
      try {
        const entry = await lstat(path);
        if (entry.isSymbolicLink() || !entry.isDirectory() || entry.uid !== uid) continue;
        await (opts.chmod ?? chmod)(path, 0o700);
      } catch {
        // Tightening is best effort; a later consumer still validates secret paths.
      }
    }
    if (rootChmodFailed)
      return withParent({ changed: false, reason: "chmod-failed", mode: before });
    return withParent(
      changed ? { changed: true, before } : { changed: false, reason: "already-private" },
    );
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

/**
 * Path of `absolutePath` relative to the data root, or null when it is outside.
 * `resolve` does not follow symlinks, so a root under `/var` (a symlink to
 * `/private/var` on macOS) is not equal to `realpath(root)`. The root itself is
 * inside when either spelling matches. A link whose target leaves the root is
 * still refused by the link-owner walk.
 */
function relativeInside(absolutePath: string, root: string, resolvedRoot: string): string | null {
  const lexical = resolve(root);
  if (absolutePath === lexical || absolutePath === resolvedRoot) return "";
  for (const base of [lexical, resolvedRoot]) {
    const prefix = `${base}${sep}`;
    if (absolutePath.startsWith(prefix)) return absolutePath.slice(prefix.length);
  }
  return null;
}

async function checkLinkOwners(path: string, check: Check, depth = 0): Promise<void> {
  const { uid, lstatFn } = check;
  if (depth > 40) fail(path, "has too many symbolic links; use a real data root");
  const absolute = resolve(path);
  const parsedRoot = isAbsolute(absolute) ? absolute.slice(0, absolute.indexOf(sep) + 1) : "/";
  const parts = absolute.slice(parsedRoot.length).split(sep).filter(Boolean);
  let current = parsedRoot;
  for (const part of parts) {
    const candidate = join(current, part);
    await checkAncestors(candidate, check);
    let entry;
    try {
      entry = await lstatFn(candidate);
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
      await checkLinkOwners(target, check, depth + 1);
      current = target;
    } else {
      current = candidate;
    }
  }
}

async function checkAncestors(rootPath: string, check: Check): Promise<void> {
  try {
    await walkAncestors(rootPath, check);
  } catch (error) {
    if (check.collect && error instanceof UnsafeSecretPathError) {
      check.collect.push(error);
      return;
    }
    throw error;
  }
}

async function walkAncestors(rootPath: string, check: Check): Promise<void> {
  const { uid, statFn } = check;
  let current = dirname(rootPath);
  while (current !== dirname(current)) {
    const st = await statFn(current);
    const mode = st.mode & 0o7777;
    if (st.uid !== 0 && st.uid !== uid)
      fail(current, `is owned by uid ${st.uid}; use a directory owned by your uid or root`);
    if ((mode & 0o1000) !== 0) return;
    if ((mode & 0o002) !== 0) fail(current, `is world-writable; run chmod o-w ${current}`);
    if ((mode & 0o020) !== 0 && !(st.uid === uid && check.isPrivate(st.gid)))
      fail(
        current,
        `is group-writable by a group that is not your private group; run chmod g-w ${current}`,
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
  opts: {
    allowMissing?: boolean;
    platform?: NodeJS.Platform;
    uid?: number;
    gid?: number;
    accounts?: AccountFiles;
    home?: string;
    lstat?: typeof lstat;
    stat?: typeof stat;
    open?: typeof open;
    /** Windows ACL reader and writer. Tests pass a fake; win32 uses icacls. */
    windowsAcl?: WindowsAclOps;
  } = {},
): Promise<void> {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") {
    await assertSafeWindows(root, path, kind, opts);
    return;
  }
  const uid = opts.uid ?? uidFor(platform);
  const lstatFn = opts.lstat ?? lstat;
  const statFn = opts.stat ?? stat;
  const openFn = opts.open ?? open;
  if (uid === undefined) return;
  const check = await makeCheck(uid, opts);

  let rootInitial;
  try {
    rootInitial = await statFn(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && opts.allowMissing) return;
    throw error;
  }
  const home = opts.home ?? homedir();
  const rootReal = await realpath(root);
  await checkLinkOwners(resolve(root), check);
  await checkAncestors(rootReal, check);
  if (
    rootInitial.uid === uid &&
    rootReal !== "/" &&
    !(home && rootReal === (await realpath(home).catch(() => resolve(home)))) &&
    (rootInitial.mode & 0o022) !== 0 &&
    (rootInitial.mode & 0o1000) === 0
  ) {
    const rootHandle = await openFn(
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
  const rootStat = await statFn(root);
  const rootMode = rootStat.mode & 0o7777;
  if (!rootStat.isDirectory()) fail(root, "is not a real directory; use a data root directory");
  if (rootStat.uid !== uid && rootStat.uid !== 0)
    fail(root, `is owned by uid ${rootStat.uid}; use a data root owned by your uid or root`);
  if ((rootMode & 0o022) !== 0 && (rootMode & 0o1000) === 0)
    fail(
      root,
      `is group-writable or world-writable (mode ${(rootMode & 0o777).toString(8)}); run chmod go-w ${root}`,
    );
  const rootHandle = await openFn(
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
  const relative = relativeInside(absolutePath, root, resolvedRoot);
  if (relative === null)
    fail(path, "is outside the data root; keep secret files inside the data root");
  const resolvedPath = join(resolvedRoot, relative);
  await checkLinkOwners(absolutePath, check);

  const parent = kind === "file" ? dirname(resolvedPath) : resolvedPath;
  const parentStat = await lstatFn(parent).catch((error: unknown) => {
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
  const dirHandle = await openFn(
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
      fileStat = await lstatFn(resolvedPath);
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
    const fileHandle = await openFn(resolvedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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

/** What to tell the operator about a tighten result. Null when the root itself needs nothing said. */
export function dataRootAccessNotice(root: string, result: TightenResult): string | null {
  if (result.changed && "before" in result) {
    return `tightened data root ${root} from ${result.before.toString(8)} to 700 (other local users could read it)`;
  }
  if (result.changed && result.via === "acl") {
    return `tightened data root ${root}: removed other accounts from the access list (current user only)`;
  }
  if (!result.changed && result.reason === "acl-failed") return `warning: ${result.message}`;
  return null;
}

function icaclsHint(path: string, sid: string): string {
  return `run icacls "${path}" /inheritance:r /grant:r "*${sid}:(OI)(CI)F" and remove every other entry`;
}

interface WindowsOpts {
  home?: string;
  windowsAcl?: WindowsAclOps;
  allowMissing?: boolean;
}

async function resolvedHome(home: string | undefined): Promise<string> {
  const value = home ?? homedir();
  if (!value) return "";
  return realpath(value).catch(() => resolve(value));
}

async function tightenWindows(root: string, opts: WindowsOpts): Promise<TightenResult> {
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { changed: false, reason: "missing" };
    return {
      changed: false,
      reason: "acl-failed",
      message: `could not read ${root} (${(error as Error).message})`,
    };
  }
  if (!rootStat.isDirectory()) {
    return {
      changed: false,
      reason: "acl-failed",
      message: `${root} is not a directory; choose a directory for the data root`,
    };
  }
  const resolvedRoot = await realpath(root).catch(() => resolve(root));
  const home = await resolvedHome(opts.home);
  if (isFilesystemRoot(resolvedRoot) || (home && resolvedRoot === home)) {
    return { changed: false, reason: "home-or-root" };
  }
  const acl = opts.windowsAcl ?? windowsAclFromRunner();
  const user = await acl.currentUser();
  if (!user) {
    return {
      changed: false,
      reason: "acl-failed",
      message: "could not identify the current Windows user, so the access list was not changed",
    };
  }
  const unsafeParent = await windowsUnsafeParent(resolvedRoot, user, acl);
  const withParent = <T extends TightenResult>(result: T): T =>
    unsafeParent ? { ...result, unsafeParent } : result;
  const rootResult = await tightenOne(resolvedRoot, user, acl);
  if (!rootResult.ok)
    return withParent({ changed: false, reason: "acl-failed", message: rootResult.message });
  let changed = rootResult.changed;
  for (const name of PRIVATE_SUBDIRS) {
    const path = join(resolvedRoot, name);
    let entry;
    try {
      entry = await lstat(path);
    } catch {
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const sub = await tightenOne(path, user, acl);
    if (sub.ok && sub.changed) changed = true;
  }
  return withParent(
    changed ? { changed: true, via: "acl" } : { changed: false, reason: "already-private" },
  );
}

async function tightenOne(
  path: string,
  user: AclPrincipal,
  acl: WindowsAclOps,
): Promise<{ ok: true; changed: boolean } | { ok: false; message: string }> {
  const view = await acl.readAcl(path);
  if (!view.ok) {
    return { ok: false, message: `could not read the access list on ${path} (${view.error})` };
  }
  if (!aclNeedsTighten(view.aces, user.sid)) return { ok: true, changed: false };
  const wrote = await acl.tightenToUser(path, user);
  if (!wrote) {
    return {
      ok: false,
      message: `could not restrict the access list on ${path} to the current user; ${icaclsHint(path, user.sid)}`,
    };
  }
  const after = await acl.readAcl(path);
  if (!after.ok || aclNeedsTighten(after.aces, user.sid)) {
    return {
      ok: false,
      message: `could not restrict the access list on ${path} to the current user; ${icaclsHint(path, user.sid)}`,
    };
  }
  return { ok: true, changed: true };
}

async function windowsUnsafeParent(
  root: string,
  user: AclPrincipal,
  acl: WindowsAclOps,
): Promise<UnsafeParent | undefined> {
  let current = parentPath(root);
  for (let depth = 0; depth < 40; depth++) {
    if (isFilesystemRoot(current)) return;
    const view = await acl.readAcl(current);
    if (view.ok) {
      const sid = parentLetsOthersWrite(view.aces, user.sid);
      if (sid) {
        return {
          path: current,
          message: `${current} lets other accounts change it (${sid}); move the data root off that folder`,
        };
      }
    }
    const next = parentPath(current);
    if (next === current) return;
    current = next;
  }
  return;
}

async function assertSafeWindows(
  root: string,
  path: string,
  kind: SecretKind,
  opts: WindowsOpts,
): Promise<void> {
  const acl = opts.windowsAcl ?? windowsAclFromRunner();
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && opts.allowMissing) return;
    throw error;
  }
  if (!rootStat.isDirectory()) fail(root, "is not a real directory; use a data root directory");
  const resolvedRoot = await realpath(root).catch(() => resolve(root));
  const home = await resolvedHome(opts.home);
  const user = await acl.currentUser();
  if (!user)
    fail(root, "could not identify the current Windows user; the access list was not checked");
  const skipRewrite = isFilesystemRoot(resolvedRoot) || (home !== "" && resolvedRoot === home);
  await requireUserOnly(resolvedRoot, user, acl, !skipRewrite);
  let current = parentPath(resolvedRoot);
  for (let depth = 0; depth < 40 && !isFilesystemRoot(current); depth++) {
    const view = await acl.readAcl(current);
    if (!view.ok) {
      fail(current, `access list could not be read (${view.error}); move the data root`);
    }
    const sid = parentLetsOthersWrite(view.aces, user.sid);
    if (sid) {
      fail(current, `lets other accounts change it (${sid}); move the data root off that folder`);
    }
    const next = parentPath(current);
    if (next === current) break;
    current = next;
  }
  const absolutePath = resolve(path);
  const relative = relativeInside(absolutePath, root, resolvedRoot);
  if (relative === null)
    fail(path, "is outside the data root; keep secret files inside the data root");
  const target = relative === "" ? resolvedRoot : join(resolvedRoot, relative);
  const parent = kind === "file" ? dirname(target) : target;
  if (!(await requireExistingUserOnly(parent, user, acl, opts.allowMissing))) return;
  if (kind === "file") await requireExistingUserOnly(target, user, acl, opts.allowMissing);
}

/** True when the path is absent and that is allowed. Throws when the ACL is wider. */
async function requireExistingUserOnly(
  path: string,
  user: AclPrincipal,
  acl: WindowsAclOps,
  allowMissing: boolean | undefined,
): Promise<boolean> {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (entry.isSymbolicLink()) {
    fail(path, "is a symbolic link; replace it with a real directory or file");
  }
  await requireUserOnly(path, user, acl, false);
  return true;
}

async function requireUserOnly(
  path: string,
  user: AclPrincipal,
  acl: WindowsAclOps,
  tighten: boolean,
): Promise<void> {
  let view = await acl.readAcl(path);
  if (!view.ok) fail(path, `access list could not be read (${view.error})`);
  // A root (tighten) drops inherited entries. A child may keep this user's inherited allow.
  if (!aclNeedsTighten(view.aces, user.sid, { acceptInheritedUser: !tighten })) return;
  if (tighten) {
    await acl.tightenToUser(path, user);
    view = await acl.readAcl(path);
    if (!view.ok) fail(path, `access list could not be read (${view.error})`);
    if (!aclNeedsTighten(view.aces, user.sid)) return;
  }
  fail(path, `is readable by other accounts; ${icaclsHint(path, user.sid)}`);
}
