import { existsSync } from "node:fs";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, open, stat } from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { z } from "zod";
import { atomicWrite } from "./atomic.js";
import { dataRootPaths } from "./paths.js";
import { withProcessLock, type ProcessLockOptions } from "./process-lock.js";
import { assertSafeForSecrets, UnsafeSecretPathError } from "./data-root-mode.js";

/** A sign-in link is single-use and lives this long. */
export const BROWSER_LINK_TTL_MS = 600_000;
/** A session that is not used for this long is refused. */
export const BROWSER_SESSION_IDLE_MS = 604_800_000;
/** A session is refused this long after it was created, even when it is used. */
export const BROWSER_SESSION_MAX_MS = 2_592_000_000;

const MAX_LINKS = 20;
const MAX_SESSIONS = 50;
/** How often a successful verify may persist `lastUsedAt`. */
const TOUCH_MIN_MS = 60_000;
const CLOCK_SKEW_MS = 60_000;
const RACY_MTIME_MS = 2_000;

class CorruptBrowserSessionFileError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class UnsafeBrowserSessionPathError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "UnsafeBrowserSessionPathError";
  }
}

/** What an HTTP client may be told about an unsafe store: the path and the fix, never uids or modes (those go to the log). */
export function browserSessionUnavailableMessage(path: string): string {
  return `Browser sign-in is unavailable: fix the permissions of ${path} (for example: chmod go-w ${path}), then run "boof-runner open" again.`;
}

export function browserSessionCookieName(port: number): string {
  return `boof_ui_${port}`;
}

export interface BrowserSession {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

export interface BrowserSessionVerifier {
  /** null for undefined, malformed, unknown, expired or revoked tokens. Never throws. */
  verify(token: string | undefined): Promise<BrowserSession | null>;
  /** Actionable reason when unsafe storage makes verification unavailable. */
  unavailableMessage?(): Promise<string | undefined>;
}

interface LinkRecord {
  hash: string;
  expiresAt: string;
  /** Port the link was minted for. Absent on links written before ports were bound. */
  port?: number;
}

interface SessionRecord {
  id: string;
  hash: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  /** Server start that minted this session. Absent on rows written before epochs. */
  epoch?: string;
}

const LinkFile = z.object({
  links: z.array(
    z.object({ hash: z.string(), expiresAt: z.string(), port: z.number().int().optional() }),
  ),
});

const SessionFile = z.object({
  /** Current server start. Sessions minted under another value are refused. */
  epoch: z.string().min(1).optional(),
  sessions: z.array(
    z.object({
      id: z.string(),
      hash: z.string(),
      createdAt: z.string(),
      lastUsedAt: z.string(),
      expiresAt: z.string(),
      epoch: z.string().min(1).optional(),
    }),
  ),
});

interface SessionCache {
  mtimeMs: number;
  size: number;
  readAtMs: number;
  sessions: SessionRecord[];
  epoch: string | null;
  /** The file was unreadable or corrupt at this mtime and size. Verify fails closed. */
  failed: boolean;
}

interface SessionState {
  epoch: string | null;
  sessions: SessionRecord[];
}

function newEpoch(): string {
  return randomBytes(32).toString("base64url");
}

/** A session is live only for the server start recorded in the file. */
function sameEpoch(current: string | null, minted: string | undefined): boolean {
  return current !== null && minted !== undefined && current === minted;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 32-byte digest, or null when `hex` is not a sha256 hex string. */
function digestBuffer(hex: string): Buffer | null {
  if (hex.length !== 64) return null;
  const buf = Buffer.from(hex, "hex");
  return buf.length === 32 ? buf : null;
}

/**
 * Hash `secret` and compare it with every stored hash. A match does not return early.
 * Never throws: a stored value that is not 64 hex chars is skipped.
 */
function findByHash<T extends { hash: string }>(rows: readonly T[], secret: string): T | null {
  const presented = Buffer.from(sha256Hex(secret), "hex");
  let found: T | null = null;
  let compared = false;
  for (const row of rows) {
    const expected = digestBuffer(row.hash);
    if (!expected) continue;
    compared = true;
    if (timingSafeEqual(presented, expected)) found ??= row;
  }
  if (!compared) timingSafeEqual(presented, Buffer.alloc(32));
  return found;
}

function at(iso: string): number {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/** Effective expiry is min(createdAt + MAX, lastUsedAt + IDLE, stored expiresAt). */
function sessionExpired(row: SessionRecord, nowMs: number): boolean {
  const absolute = at(row.createdAt) + BROWSER_SESSION_MAX_MS;
  const idle = at(row.lastUsedAt) + BROWSER_SESSION_IDLE_MS;
  return (
    at(row.createdAt) > nowMs + CLOCK_SKEW_MS ||
    at(row.lastUsedAt) > nowMs + CLOCK_SKEW_MS ||
    nowMs >= Math.min(absolute, idle, at(row.expiresAt))
  );
}

function pruneLinks(rows: readonly LinkRecord[], nowMs: number): LinkRecord[] {
  return rows.filter(
    (row) =>
      nowMs < at(row.expiresAt) && at(row.expiresAt) <= nowMs + BROWSER_LINK_TTL_MS + CLOCK_SKEW_MS,
  );
}

function pruneSessions(rows: readonly SessionRecord[], nowMs: number): SessionRecord[] {
  return rows.filter((row) => !sessionExpired(row, nowMs));
}

/**
 * Keep the newest `max - 1` rows so the caller can append one. Rows are in creation order;
 * the front is the oldest.
 */
function roomForOne<T>(rows: T[], max: number): T[] {
  if (rows.length < max) return rows;
  return rows.slice(rows.length - (max - 1));
}

function toPublic(record: SessionRecord): BrowserSession {
  const effectiveExpiry = Math.min(
    at(record.createdAt) + BROWSER_SESSION_MAX_MS,
    at(record.lastUsedAt) + BROWSER_SESSION_IDLE_MS,
  );
  return {
    id: record.id,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: new Date(effectiveExpiry).toISOString(),
  };
}

function cleanLink(row: LinkRecord): LinkRecord {
  return row.port === undefined
    ? { hash: row.hash, expiresAt: row.expiresAt }
    : { hash: row.hash, expiresAt: row.expiresAt, port: row.port };
}

function cleanSession(row: SessionRecord): SessionRecord {
  return {
    id: row.id,
    hash: row.hash,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    ...(row.epoch ? { epoch: row.epoch } : {}),
  };
}

function sessionDocument(
  epoch: string | null,
  rows: readonly SessionRecord[],
): {
  epoch?: string;
  sessions: SessionRecord[];
} {
  return {
    ...(epoch ? { epoch } : {}),
    sessions: rows.map(cleanSession),
  };
}

function parseStored<T>(text: string, schema: z.ZodType<{ [key: string]: T[] }>, key: string): T[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("corrupt");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error("corrupt");
  return parsed.data[key] ?? [];
}

/**
 * Browser sign-in links and sessions for the local web UI.
 *
 * Both files store sha256 hex of the secret, never the secret. `auth/` is 0700 and the files
 * are 0600. Link and session mutations read and write under one cross-process lock, so a link
 * minted by another process cannot race a redemption or revoke. `verify` stats the sessions file
 * on every call and reloads it when the mtime or size changed.
 *
 * `beginEpoch` runs once per server start and stores a new random epoch under that lock.
 * `verify` accepts only a session minted in the epoch currently in the file, so a cookie
 * harvested while the server was down is dead when it comes back. The desktop app mints a
 * session per window after the server has started, so that window stays signed in.
 */
export class BrowserSessionStore implements BrowserSessionVerifier {
  private readonly linksPath: string;
  private readonly sessionsPath: string;
  private readonly authDir: string;
  private readonly lockPath: string;
  private readonly lockOpts: ProcessLockOptions;
  private cache: SessionCache | null = null;
  private loggedStatError = false;
  private loggedUnexpected = false;
  private unsafeMessage: string | undefined;
  private readonly loggedCorruptPaths = new Set<string>();
  private readonly chmodFn: typeof chmod;
  private readonly warnedChmodPaths = new Set<string>();
  private readonly root: string;
  private readonly uid: number | undefined;
  private readonly openFn: typeof open;
  private readonly loggedUnsafePaths = new Set<string>();
  private readonly lstatFn: typeof lstat;
  private readonly statFn: typeof stat;

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
    opts: {
      lock?: ProcessLockOptions;
      chmod?: typeof chmod;
      uid?: number;
      open?: typeof open;
      /** Filesystem seams used by security tests; production callers should omit these. */
      lstat?: typeof lstat;
      stat?: typeof stat;
    } = {},
  ) {
    const paths = dataRootPaths(root);
    this.linksPath = paths.browserLinks;
    this.sessionsPath = paths.browserSessions;
    this.authDir = paths.auth;
    this.lockPath = `${paths.auth}/.browser-session.lock`;
    this.lockOpts = opts.lock ?? {};
    this.chmodFn = opts.chmod ?? chmod;
    this.openFn = opts.open ?? open;
    this.lstatFn = opts.lstat ?? lstat;
    this.statFn = opts.stat ?? stat;
    this.root = paths.root;
    this.uid = opts.uid ?? process.getuid?.();
  }

  async createLink(opts: { port?: number } = {}): Promise<{ code: string; expiresAt: string }> {
    return this.mutate(async ({ links, sessions, epoch }) => {
      const nowMs = this.now();
      const code = `bl_${randomBytes(32).toString("base64url")}`;
      const expiresAt = new Date(nowMs + BROWSER_LINK_TTL_MS).toISOString();
      const nextLinks = roomForOne(pruneLinks(links, nowMs), MAX_LINKS);
      nextLinks.push({
        hash: sha256Hex(code),
        expiresAt,
        ...(opts.port !== undefined ? { port: opts.port } : {}),
      });
      await this.commit(nextLinks, pruneSessions(sessions, nowMs), { links, sessions, epoch });
      return { code, expiresAt };
    });
  }

  /**
   * `opts.port` is the port the request arrived on. A link minted for another port is burned and
   * refused, so a link printed for the wrong port cannot be redeemed by whoever holds that port.
   */
  async redeemLink(
    code: string,
    opts: { port?: number } = {},
  ): Promise<{ token: string; session: BrowserSession } | null> {
    return this.mutate(async ({ links, sessions, epoch }) => {
      const nowMs = this.now();
      const liveLinks = pruneLinks(links, nowMs);
      const liveSessions = pruneSessions(sessions, nowMs);
      const match =
        typeof code === "string" && code.length > 0 ? findByHash(liveLinks, code) : null;
      if (!match) {
        await this.commit(liveLinks, liveSessions, { links, sessions, epoch });
        return null;
      }
      // Drop the link before the session is added, so a crash cannot leave it redeemable twice.
      const keptLinks = liveLinks.filter((link) => link !== match);
      if (match.port !== undefined && opts.port !== undefined && match.port !== opts.port) {
        await this.commit(keptLinks, liveSessions, { links, sessions, epoch });
        return null;
      }
      const current = epoch ?? newEpoch();
      const minted = this.mint(liveSessions, nowMs, current);
      await this.commit(keptLinks, minted.sessions, { links, sessions, epoch }, undefined, current);
      return { token: minted.token, session: minted.session };
    });
  }

  async createSession(): Promise<{ token: string; session: BrowserSession }> {
    return this.mutate(async ({ links, sessions, epoch }) => {
      const nowMs = this.now();
      const current = epoch ?? newEpoch();
      const minted = this.mint(pruneSessions(sessions, nowMs), nowMs, current);
      await this.commit(
        pruneLinks(links, nowMs),
        minted.sessions,
        { links, sessions, epoch },
        undefined,
        current,
      );
      return { token: minted.token, session: minted.session };
    });
  }

  /**
   * New server start. Under the session lock, replace the stored epoch and drop every session.
   * Pending sign-in links stay: they are single-use and are not cookies. A corrupt session file
   * is replaced so startup can still mint a fresh epoch.
   */
  async beginEpoch(): Promise<void> {
    // No session or link file yet: there is nothing to invalidate, and a mint creates its own
    // epoch. Do not create the auth directory just by starting the server.
    if (!existsSync(this.sessionsPath) && !existsSync(this.linksPath)) return;
    await this.mutate(async ({ links, sessions, epoch }) => {
      const nowMs = this.now();
      await this.commit(
        pruneLinks(links, nowMs),
        [],
        { links, sessions, epoch },
        { links: false, sessions: true },
        newEpoch(),
      );
    }, true);
  }

  async verify(token: string | undefined): Promise<BrowserSession | null> {
    try {
      if (typeof token !== "string" || token.length === 0) return null;
      await this.assertTrustedDirectories();
      const loaded = await this.cachedSessions();
      if (!loaded) return null;
      const match = findByHash(loaded.sessions, token);
      if (!match || !sameEpoch(loaded.epoch, match.epoch)) return null;
      const nowMs = this.now();
      if (sessionExpired(match, nowMs)) return null;
      if (nowMs - at(match.lastUsedAt) < TOUCH_MIN_MS) return toPublic(match);
      const updated = await this.touch(token, nowMs);
      return updated ? toPublic(updated) : null;
    } catch (error) {
      if (error instanceof UnsafeBrowserSessionPathError) {
        this.logUnsafeOnce(error);
        this.unsafeMessage = browserSessionUnavailableMessage(error.path);
        return null;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (!(error instanceof CorruptBrowserSessionFileError) && !this.loggedUnexpected) {
        this.loggedUnexpected = true;
        console.error(
          `browser sessions: verify failed (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      return null;
    }
  }

  async unavailableMessage(): Promise<string | undefined> {
    try {
      await this.assertTrustedDirectories();
      await this.cachedSessions();
    } catch (error) {
      if (error instanceof UnsafeBrowserSessionPathError) {
        this.logUnsafeOnce(error);
        this.unsafeMessage = browserSessionUnavailableMessage(error.path);
      }
    }
    return this.unsafeMessage;
  }

  /** Delete one session by id; true when a live session was removed. Other sessions are untouched. */
  async revokeSession(id: string): Promise<boolean> {
    return this.mutate(async ({ links, sessions, epoch }) => {
      const nowMs = this.now();
      const live = pruneSessions(sessions, nowMs);
      const next = live.filter((row) => row.id !== id);
      await this.commit(pruneLinks(links, nowMs), next, { links, sessions, epoch });
      return next.length !== live.length;
    });
  }

  /** Delete every session and pending sign-in link; return the number of live sessions removed. */
  async revokeAll(): Promise<number> {
    return this.mutate(async ({ links, sessions, epoch, corrupt }) => {
      const liveCount = pruneSessions(sessions, this.now()).length;
      await this.commit([], [], { links, sessions, epoch }, corrupt);
      return liveCount;
    }, true);
  }

  private mint(
    sessions: SessionRecord[],
    nowMs: number,
    epoch: string,
  ): { token: string; session: BrowserSession; sessions: SessionRecord[] } {
    const next = roomForOne(sessions, MAX_SESSIONS);
    const token = `bs_${randomBytes(32).toString("base64url")}`;
    const createdAt = new Date(nowMs).toISOString();
    const record: SessionRecord = {
      id: randomUUID(),
      hash: sha256Hex(token),
      createdAt,
      lastUsedAt: createdAt,
      expiresAt: new Date(nowMs + BROWSER_SESSION_MAX_MS).toISOString(),
      epoch,
    };
    next.push(record);
    return { token, session: toPublic(record), sessions: next };
  }

  /** Re-read under the lock and persist `lastUsedAt` when the session is still live. */
  private touch(token: string, nowMs: number): Promise<SessionRecord | null> {
    return this.mutate(async ({ links, sessions, epoch }) => {
      const liveLinks = pruneLinks(links, nowMs);
      const liveSessions = pruneSessions(sessions, nowMs);
      const match = findByHash(liveSessions, token);
      if (!match || !sameEpoch(epoch, match.epoch) || nowMs - at(match.lastUsedAt) < TOUCH_MIN_MS) {
        await this.commit(liveLinks, liveSessions, { links, sessions, epoch });
        return match && sameEpoch(epoch, match.epoch) ? match : null;
      }
      const updated: SessionRecord = { ...match, lastUsedAt: new Date(nowMs).toISOString() };
      const next = liveSessions.map((row) => (row === match ? updated : row));
      await this.commit(liveLinks, next, { links, sessions, epoch });
      return updated;
    });
  }

  private mutate<T>(
    fn: (state: {
      links: LinkRecord[];
      sessions: SessionRecord[];
      epoch: string | null;
      corrupt: { links: boolean; sessions: boolean };
    }) => Promise<T>,
    resetCorrupt = false,
  ): Promise<T> {
    return (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await this.assertTrustedRoot();
      await mkdir(this.authDir, { recursive: true, mode: 0o700 });
      await this.chmodPortable(this.authDir, 0o700);
      await this.assertTrustedDirectories();
      return withProcessLock(
        this.lockPath,
        this.lockOpts,
        async () => {
          let links: LinkRecord[];
          let sessions: SessionRecord[];
          let epoch: string | null = null;
          let linksCorrupt = false;
          let sessionsCorrupt = false;
          try {
            links = await this.readLinks();
          } catch (error) {
            if (!this.isCorrupt(error)) throw error;
            this.logCorruptOnce(
              this.linksPath,
              error instanceof CorruptBrowserSessionFileError ? error.code : undefined,
            );
            if (!resetCorrupt) throw error;
            links = [];
            linksCorrupt = true;
          }
          try {
            const state = await this.readSessionState();
            sessions = state.sessions;
            epoch = state.epoch;
          } catch (error) {
            if (!this.isCorrupt(error)) throw error;
            this.logCorruptOnce(
              this.sessionsPath,
              error instanceof CorruptBrowserSessionFileError ? error.code : undefined,
            );
            if (!resetCorrupt) throw error;
            sessions = [];
            epoch = null;
            sessionsCorrupt = true;
          }
          return fn({
            links,
            sessions,
            epoch,
            corrupt: { links: linksCorrupt, sessions: sessionsCorrupt },
          });
        },
        (holder, path) =>
          new Error(
            `Another boof process is updating browser sessions (pid ${holder}); try again in a moment, or remove ${path} if no boof process is running`,
          ),
      );
    })();
  }

  private isCorrupt(error: unknown): boolean {
    return error instanceof CorruptBrowserSessionFileError;
  }

  private async readLinks(): Promise<LinkRecord[]> {
    const rows = await this.readRecords(this.linksPath, (text) =>
      parseStored(text, LinkFile, "links"),
    );
    return rows.map(cleanLink);
  }

  private async readSessionState(): Promise<SessionState> {
    const parsed = await this.readRecords(this.sessionsPath, (text) => {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("corrupt");
      }
      const result = SessionFile.safeParse(json);
      if (!result.success) throw new Error("corrupt");
      const epoch = result.data.epoch;
      return [
        {
          epoch: typeof epoch === "string" && epoch.length > 0 ? epoch : null,
          sessions: result.data.sessions.map(cleanSession),
        },
      ];
    });
    return parsed[0] ?? { epoch: null, sessions: [] };
  }

  /** Missing file is an empty list. Anything else throws, without the file body in the message. */
  private async readRecords<T>(path: string, parse: (text: string) => T[]): Promise<T[]> {
    let text: string;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
      handle = await this.openFn(path, flags);
      const fileStat = await handle.stat();
      this.assertSafeStat(path, fileStat, "file");
      if (this.hasReadBits(fileStat.mode)) this.warnReadBits(path);
      text = await handle.readFile("utf8");
    } catch (err) {
      if (err instanceof UnsafeBrowserSessionPathError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ELOOP") {
        throw new UnsafeBrowserSessionPathError(
          path,
          `${path} is not a safe file; chmod 600 ${path}`,
        );
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      const code = (err as NodeJS.ErrnoException).code;
      throw new CorruptBrowserSessionFileError(
        `${path} is unreadable (${code ?? "unknown"}); not updating browser sessions`,
        code,
      );
    } finally {
      await handle?.close();
    }
    try {
      return parse(text);
    } catch {
      throw new CorruptBrowserSessionFileError(`${path} is corrupt; not updating browser sessions`);
    }
  }

  private async commit(
    links: LinkRecord[],
    sessions: SessionRecord[],
    prev: { links: LinkRecord[]; sessions: SessionRecord[]; epoch: string | null },
    force: { links: boolean; sessions: boolean } = { links: false, sessions: false },
    epoch: string | null = prev.epoch,
  ): Promise<void> {
    if (
      force.links ||
      JSON.stringify(links.map(cleanLink)) !== JSON.stringify(prev.links.map(cleanLink))
    ) {
      await this.persist(this.linksPath, { links: links.map(cleanLink) });
    }
    const nextSessions = sessionDocument(epoch, sessions);
    const prevSessions = sessionDocument(prev.epoch, prev.sessions);
    if (force.sessions || JSON.stringify(nextSessions) !== JSON.stringify(prevSessions)) {
      await this.persist(this.sessionsPath, nextSessions);
    }
  }

  private async persist(path: string, body: unknown): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.assertTrustedRoot();
    await mkdir(this.authDir, { recursive: true, mode: 0o700 });
    await this.chmodPortable(this.authDir, 0o700);
    await this.assertTrustedDirectories();
    // The process lock already serializes writers; avoid re-entering a non-reentrant file lock.
    await atomicWrite(path, `${JSON.stringify(body, null, 2)}\n`, 0o600);
    await this.chmodPortable(path, 0o600);
    const fileStat = await lstat(path);
    this.assertSafeStat(path, fileStat, "file");
    if (path === this.sessionsPath) this.cache = null;
  }

  /**
   * Stat on every call. Re-read files with a recent mtime to cover coarse timestamp resolution.
   * A failure is cached with that stat so a still-corrupt file logs once.
   */
  private async cachedSessions(): Promise<SessionState | null> {
    let fileStat: { mtimeMs: number; size: number };
    try {
      const st = await lstat(this.sessionsPath);
      this.assertSafeStat(this.sessionsPath, st, "file");
      this.unsafeMessage = undefined;
      if (this.hasReadBits(st.mode)) this.warnReadBits(this.sessionsPath);
      fileStat = { mtimeMs: st.mtimeMs, size: st.size };
      this.loggedStatError = false;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (err instanceof UnsafeBrowserSessionPathError) {
        this.logUnsafeOnce(err);
        this.unsafeMessage = browserSessionUnavailableMessage(err.path);
        return null;
      }
      if (code === "ENOENT") {
        this.unsafeMessage = undefined;
        this.cache = null;
        return { epoch: null, sessions: [] };
      }
      if (!this.loggedStatError) {
        this.loggedStatError = true;
        this.logBad(this.sessionsPath, code);
      }
      return null;
    }

    if (
      this.cache &&
      this.cache.mtimeMs === fileStat.mtimeMs &&
      this.cache.size === fileStat.size &&
      Math.abs(fileStat.mtimeMs - this.cache.readAtMs) > RACY_MTIME_MS &&
      Math.abs(Date.now() - fileStat.mtimeMs) > RACY_MTIME_MS
    ) {
      return this.cache.failed ? null : { epoch: this.cache.epoch, sessions: this.cache.sessions };
    }

    try {
      const state = await this.readSessionState();
      this.cache = {
        ...fileStat,
        readAtMs: Date.now(),
        sessions: state.sessions,
        epoch: state.epoch,
        failed: false,
      };
      return state;
    } catch (error) {
      if (error instanceof UnsafeBrowserSessionPathError) {
        this.logUnsafeOnce(error);
        this.unsafeMessage = browserSessionUnavailableMessage(error.path);
        return null;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      this.cache = {
        ...fileStat,
        readAtMs: Date.now(),
        sessions: [],
        epoch: null,
        failed: true,
      };
      this.logCorruptOnce(
        this.sessionsPath,
        error instanceof CorruptBrowserSessionFileError ? error.code : undefined,
      );
      return null;
    }
  }

  /** One line, and never the file body: a parser message would quote a secret if one were there. */
  private logBad(path: string, code?: string): void {
    console.error(
      `browser sessions: ${path} is unreadable or corrupt${code ? ` (${code})` : ""}; treating it as no sessions`,
    );
  }

  private logCorruptOnce(path: string, code?: string): void {
    if (this.loggedCorruptPaths.has(path)) return;
    this.loggedCorruptPaths.add(path);
    this.logBad(path, code);
  }

  private async assertTrustedDirectories(): Promise<void> {
    if (this.uid === undefined) return; // Windows has no POSIX ownership/mode contract.
    await this.assertTrustedRoot();
    try {
      await assertSafeForSecrets(this.root, this.authDir, "directory", {
        uid: this.uid,
        lstat: this.lstatFn,
        stat: this.statFn,
      });
    } catch (error) {
      if (error instanceof UnsafeSecretPathError)
        throw new UnsafeBrowserSessionPathError(error.path, error.message);
      throw error;
    }
    const authStat = await this.lstatFn(this.authDir);
    this.assertSafeStat(this.authDir, authStat, "directory");
    if (this.hasReadBits(authStat.mode)) this.warnReadBits(this.authDir);
  }

  private async assertTrustedRoot(): Promise<void> {
    if (this.uid === undefined) return;
    const linkStat = await this.lstatFn(this.root);
    let rootStat = linkStat;
    if (linkStat.isSymbolicLink()) {
      if (linkStat.uid !== this.uid && linkStat.uid !== 0) {
        throw new UnsafeBrowserSessionPathError(
          this.root,
          `${this.root} is a symbolic link owned by uid ${linkStat.uid}; use a data root you own`,
        );
      }
      rootStat = await this.statFn(this.root);
    }
    const mode = rootStat.mode & 0o7777;
    if (rootStat.uid === this.uid && (mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
      try {
        await this.chmodFn(this.root, mode & ~0o022);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!this.warnedChmodPaths.has(this.root)) {
          this.warnedChmodPaths.add(this.root);
          console.warn(
            `browser sessions: could not set permissions on ${this.root} (${code ?? "unknown"}); checking ownership and mode`,
          );
        }
      }
      const checkedLinkStat = await this.lstatFn(this.root);
      if (checkedLinkStat.isSymbolicLink() !== linkStat.isSymbolicLink()) {
        throw new UnsafeBrowserSessionPathError(
          this.root,
          `${this.root} changed between a folder and a symbolic link while checking permissions; use a data root you own`,
        );
      }
      rootStat = await this.statFn(this.root);
    }
    this.assertSafeStat(this.root, rootStat, "root");
  }

  private assertSafeStat(path: string, fileStat: Stats, kind: "root" | "directory" | "file"): void {
    if (this.uid === undefined) return;
    const mode = fileStat.mode & 0o7777;
    const ownerOk =
      kind === "root" ? fileStat.uid === this.uid || fileStat.uid === 0 : fileStat.uid === this.uid;
    const typeOk =
      kind === "root" ||
      (kind === "directory"
        ? fileStat.isDirectory() && !fileStat.isSymbolicLink()
        : fileStat.isFile());
    const writable = (mode & 0o022) !== 0 && !(kind === "root" && (mode & 0o1000) !== 0);
    const fix =
      kind === "root"
        ? fileStat.uid === this.uid
          ? `chmod go-w ${path}`
          : "use a data root you own"
        : `chmod ${kind === "file" ? "600" : "700"} ${path}`;
    if (!typeOk)
      throw new UnsafeBrowserSessionPathError(path, `${path} is not a safe ${kind}; ${fix}`);
    if (!ownerOk)
      throw new UnsafeBrowserSessionPathError(
        path,
        `${path} is owned by uid ${fileStat.uid}; ${fix}`,
      );
    if (writable)
      throw new UnsafeBrowserSessionPathError(
        path,
        `${path} is group-writable or world-writable (mode ${mode.toString(8)}); ${fix}`,
      );
  }

  private hasReadBits(mode: number): boolean {
    return (mode & 0o044) !== 0;
  }

  private warnReadBits(path: string): void {
    if (this.warnedChmodPaths.has(`read:${path}`)) return;
    this.warnedChmodPaths.add(`read:${path}`);
    console.warn(`browser sessions: ${path} has group or world read bits`);
  }

  private logUnsafeOnce(error: UnsafeBrowserSessionPathError): void {
    if (this.loggedUnsafePaths.has(error.path)) return;
    this.loggedUnsafePaths.add(error.path);
    console.error(`browser sessions: ${error.message}`);
  }

  private async chmodPortable(path: string, mode: number): Promise<void> {
    if (path === this.authDir && this.uid !== undefined) {
      const before = await this.lstatFn(path);
      if (before.isSymbolicLink()) {
        this.assertSafeStat(path, before, "directory");
      }
    }
    try {
      await this.chmodFn(path, mode);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!this.warnedChmodPaths.has(path)) {
        this.warnedChmodPaths.add(path);
        console.warn(
          `browser sessions: could not set permissions on ${path} (${code ?? "unknown"}); checking ownership and mode`,
        );
      }
    }
    if (path === this.authDir) {
      const directoryStat = await this.lstatFn(path);
      this.assertSafeStat(path, directoryStat, "directory");
      if (this.hasReadBits(directoryStat.mode)) this.warnReadBits(path);
    } else {
      const fileStat = await this.lstatFn(path);
      this.assertSafeStat(path, fileStat, "file");
      if (this.hasReadBits(fileStat.mode)) this.warnReadBits(path);
    }
  }
}
