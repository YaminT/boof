import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { execCommand } from "./process.js";

/**
 * Windows stand-in for a mode 0700 data root. icacls speaks in names that change with the
 * locale, so the check reads the DACL as SDDL (SIDs) via `icacls /save`. A directory the
 * current user created is private when its allow entries are that user, SYSTEM and
 * Administrators, including the `LA` alias icacls uses for the built-in Administrator
 * (RID 500). Users, Everyone, Authenticated Users and any other account are a shared folder.
 * The list is not rewritten in the private case: stripping those entries removes the owner's
 * own access.
 */

export interface AclPrincipal {
  /** `DOMAIN\\user` from whoami. */
  account: string;
  /** SID, `S-1-...`. */
  sid: string;
}

export interface AclAce {
  /** SID or a two-letter SDDL alias (`WD`, `BA`, `SY`, ...). */
  sid: string;
  allow: boolean;
  /** The ACE was inherited. A protected user-only list has none. */
  inherited: boolean;
  /** Inherit-only: does not grant access to this folder itself. */
  inheritOnly: boolean;
  /** SDDL rights, either two-letter codes (`FA`) or a hex mask. */
  rights: string;
  /**
   * Conditional ACE (`XA` or `ZA`). The condition is not evaluated; the entry is unsafe.
   * Absent on ACEs this parser built from an allow or deny.
   */
  conditional?: boolean;
}

export type AclView = { ok: true; aces: AclAce[] } | { ok: false; error: string };

export interface WindowsAclOps {
  currentUser(): Promise<AclPrincipal | null>;
  readAcl(path: string): Promise<AclView>;
  /** Replace the DACL with one full-control allow ACE for `user`. False when that did not stick. */
  tightenToUser(path: string, user: AclPrincipal): Promise<boolean>;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

const WRITE_BITS =
  0x2 | // FILE_WRITE_DATA
  0x4 | // FILE_APPEND_DATA
  0x10 | // FILE_WRITE_EA
  0x40 | // FILE_DELETE_CHILD
  0x100 | // FILE_WRITE_ATTRIBUTES
  0x10000 | // DELETE
  0x40000 | // WRITE_DAC
  0x80000 | // WRITE_OWNER
  0x10000000 | // GENERIC_ALL
  0x40000000; // GENERIC_WRITE

/** `DT` is delete-tree, `CR` is control access, `DC` is delete-child. `LC` (list children) is not. */
const WRITE_CODES = new Set(["FA", "FW", "GA", "GW", "WD", "WO", "SD", "DC", "DT", "CR"]);

/** Two-letter SDDL account aliases. Compared as full SIDs. */
const ALIAS_SID: Record<string, string> = {
  WD: "S-1-1-0",
  CO: "S-1-3-0",
  CG: "S-1-3-1",
  OW: "S-1-3-4",
  IU: "S-1-5-4",
  SU: "S-1-5-6",
  AN: "S-1-5-7",
  AU: "S-1-5-11",
  SY: "S-1-5-18",
  BA: "S-1-5-32-544",
  BU: "S-1-5-32-545",
  BG: "S-1-5-32-546",
};

/** SYSTEM and Administrators. Normal on a profile and on a directory the user just created. */
const BENIGN_OWNER = new Set(["S-1-5-18", "S-1-5-32-544"]);

/**
 * Built-in Administrator. `icacls /save` writes the alias `LA`, while `whoami` writes
 * `S-1-5-21-<machine>-500`. `LA` is that account only, so it is not a fixed SID.
 */
const LOCAL_ADMIN_RID = /^S-1-5-21-\d+-\d+-\d+-500$/i;

export function canonicalSid(sid: string): string {
  const trimmed = sid.trim();
  const key = trimmed.toUpperCase();
  return ALIAS_SID[key] ?? key;
}

/** True when `aceSid` is this user. `LA` matches only a user whose SID is the RID-500 account. */
export function sameAccount(aceSid: string, userSid: string): boolean {
  const ace = canonicalSid(aceSid);
  const user = canonicalSid(userSid);
  if (ace === user) return true;
  return ace === "LA" && LOCAL_ADMIN_RID.test(user);
}

export function isFilesystemRoot(path: string): boolean {
  if (path === "/" || path === "\\" || path === "") return true;
  return /^[A-Za-z]:\\?$/.test(path);
}

export function rightsIncludeWrite(rights: string): boolean {
  const value = rights.trim().toUpperCase();
  if (!value) return false;
  if (value.startsWith("0X")) {
    const mask = Number(value);
    return Number.isFinite(mask) && (mask & WRITE_BITS) !== 0;
  }
  for (let i = 0; i + 1 < value.length; i += 2) {
    if (WRITE_CODES.has(value.slice(i, i + 2))) return true;
  }
  return false;
}

function flagSet(flags: string): Set<string> {
  const out = new Set<string>();
  const value = flags.toUpperCase();
  for (let i = 0; i + 1 < value.length; i += 2) out.add(value.slice(i, i + 2));
  return out;
}

/** The DACL body of one SDDL line, from `D:` up to a top-level `S:`. */
export function extractDacl(line: string): string | null {
  let depth = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && line.startsWith("D:", i)) {
      let end = i + 2;
      let nested = 0;
      for (; end < line.length; end++) {
        const at = line[end];
        if (at === "(") nested++;
        else if (at === ")") nested = Math.max(0, nested - 1);
        else if (nested === 0 && line.startsWith("S:", end)) break;
      }
      return line.slice(i + 2, end);
    }
  }
  return null;
}

export function parseDacl(dacl: string): AclAce[] {
  const aces: AclAce[] = [];
  const re = /\(([A-Z]+);([^;]*);([^;]*);([^;]*);([^;]*);([^)]*)\)/g;
  for (const match of dacl.matchAll(re)) {
    const type = match[1] ?? "";
    const conditional = type === "XA" || type === "ZA";
    const sid = match[6]?.trim() ?? "";
    if (!sid && !conditional) continue;
    const flags = flagSet(match[2] ?? "");
    aces.push({
      sid,
      allow: type === "A",
      inherited: flags.has("ID"),
      inheritOnly: flags.has("IO"),
      rights: (match[3] ?? "").trim(),
      conditional,
    });
  }
  // A conditional ACE can carry a nested `)` in its condition, which the field split skips.
  if (/\((XA|ZA);/i.test(dacl) && !aces.some((ace) => ace.conditional)) {
    aces.push({
      sid: "",
      allow: false,
      inherited: false,
      inheritOnly: false,
      rights: "",
      conditional: true,
    });
  }
  return aces;
}

/** Text of an `icacls /save` file (UTF-8 or UTF-16 LE). The first security-descriptor line wins. */
export function parseIcaclsSave(text: string): AclView {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.includes("D:"));
  if (!line) return { ok: false, error: "icacls save had no DACL" };
  const dacl = extractDacl(line);
  if (dacl === null) return { ok: false, error: "icacls save had no DACL" };
  return { ok: true, aces: parseDacl(dacl) };
}

export function decodeIcaclsText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
    return buf.subarray(2).toString("utf16le");
  // icacls /save commonly emits UTF-16LE without a BOM. ASCII-heavy output contains
  // zero bytes in every other position, which distinguishes it from its UTF-8 form.
  const sampleLength = Math.min(buf.length, 128);
  let oddZeros = 0;
  let evenZeros = 0;
  for (let i = 0; i < sampleLength; i++) {
    if (buf[i] === 0) {
      if (i % 2 === 0) evenZeros++;
      else oddZeros++;
    }
  }
  if (oddZeros > sampleLength / 8 && oddZeros > evenZeros * 2) return buf.toString("utf16le");
  return buf.toString("utf8");
}

export interface AclTightenOptions {
  /**
   * A child of a tightened root may keep an inherited allow for this user
   * (`(A;OICIID;FA;;;<user>)`). Inherited SYSTEM, Administrators and the owner are
   * private either way. An inherited allow for any other account is not.
   */
  acceptInheritedUser?: boolean;
}

/**
 * True when the list is not private to this user.
 * SYSTEM, Administrators and the user (including inherited allows, and `LA` for the RID-500
 * account) are the access a new directory gets from its parent. They are left alone.
 * An allow for anyone else, a missing user write, or a conditional ACE (`XA`/`ZA`, whose
 * condition is not evaluated) is not private. `acceptInheritedUser` still accepts an inherited
 * allow for this user; that case is already private either way.
 */
export function aclNeedsTighten(
  aces: AclAce[],
  userSid: string,
  opts?: AclTightenOptions,
): boolean {
  const acceptInherited = opts?.acceptInheritedUser === true;
  let userWrite = false;
  for (const ace of aces) {
    if (ace.conditional) return true;
    const sid = canonicalSid(ace.sid);
    const mine = sameAccount(ace.sid, userSid);
    const benign = BENIGN_OWNER.has(sid);
    // An inherited allow for some other account is a parent sharing the folder.
    if (ace.inherited && !acceptInherited && !mine && !benign) return true;
    if (mine) {
      if (!ace.allow && rightsIncludeWrite(ace.rights)) return true;
      if (ace.allow && !ace.inheritOnly && rightsIncludeWrite(ace.rights)) userWrite = true;
      continue;
    }
    if (benign) continue;
    // Even inherit-only grants matter on a root: future children inherit them.
    if (ace.allow) return true;
  }
  return !userWrite;
}

/**
 * SID of an account other than the user, SYSTEM or Administrators that can write this
 * directory, or null. Everyone, Users, Authenticated Users and any other account are a
 * shared folder. `LA` is the user when that user is the built-in Administrator.
 */
export function parentLetsOthersWrite(aces: AclAce[], userSid: string): string | null {
  for (const ace of aces) {
    if (ace.conditional) return "conditional";
    if (!ace.allow || ace.inheritOnly || !rightsIncludeWrite(ace.rights)) continue;
    const sid = canonicalSid(ace.sid);
    if (sameAccount(ace.sid, userSid) || BENIGN_OWNER.has(sid)) continue;
    return sid;
  }
  return null;
}

export function parseWhoamiCsv(stdout: string): AclPrincipal | null {
  const line = stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("User Name"));
  if (!line) return null;
  const quoted = [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");
  const account = quoted[0] ?? line.split(",")[0]?.trim();
  const sid = quoted[1] ?? line.split(",")[1]?.trim();
  if (!account || !sid || !sid.toUpperCase().startsWith("S-1-")) return null;
  return { account, sid };
}

async function defaultRun(command: string, args: string[]): Promise<CommandResult> {
  const res = await execCommand(command, args, { cwd: tmpdir(), timeoutMs: 15_000 });
  return { code: res.code, stdout: res.stdout, stderr: res.stderr };
}

async function readSavedAcl(path: string, run: CommandRunner): Promise<AclView> {
  const file = join(
    tmpdir(),
    `boof-acl-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
  );
  try {
    const res = await run("icacls", [path, "/save", file, "/C", "/Q"]);
    if (res.code !== 0)
      return { ok: false, error: (res.stderr || res.stdout || "icacls /save failed").trim() };
    return parseIcaclsSave(decodeIcaclsText(await readFile(file)));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(file, { force: true }).catch(() => {});
  }
}

async function loadUser(run: CommandRunner): Promise<AclPrincipal | null> {
  const res = await run("whoami", ["/user", "/fo", "csv", "/nh"]);
  if (res.code !== 0) return null;
  return parseWhoamiCsv(res.stdout);
}

async function tightenToUser(
  path: string,
  user: AclPrincipal,
  run: CommandRunner,
): Promise<boolean> {
  const grant = await run("icacls", [path, "/grant:r", `*${user.sid}:(OI)(CI)F`, "/C", "/Q"]);
  if (grant.code !== 0) return false;
  const inheritance = await run("icacls", [path, "/inheritance:r", "/C", "/Q"]);
  if (inheritance.code !== 0) return false;
  const current = await readSavedAcl(path, run);
  if (!current.ok) return false;
  const others = [
    ...new Set(
      current.aces
        .filter((ace) => canonicalSid(ace.sid) !== canonicalSid(user.sid))
        .map((ace) => canonicalSid(ace.sid)),
    ),
  ];
  for (const sid of others) {
    const removed = await run("icacls", [path, "/remove", `*${sid}`, "/C", "/Q"]);
    if (removed.code !== 0) return false;
  }
  const after = await readSavedAcl(path, run);
  return after.ok && !aclNeedsTighten(after.aces, user.sid);
}

export function windowsAclFromRunner(run: CommandRunner = defaultRun): WindowsAclOps {
  let user: Promise<AclPrincipal | null> | undefined;
  return {
    currentUser: () => (user ??= loadUser(run)),
    readAcl: (path) => readSavedAcl(path, run),
    tightenToUser: (path, principal) => tightenToUser(path, principal, run),
  };
}

/** Parent of `path` using Windows separators when the check itself is for win32. */
export function parentPath(path: string): string {
  return win32.dirname(path);
}
