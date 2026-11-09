import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { atomicWrite } from "./atomic.js";
import { dataRootPaths } from "./paths.js";
import { withProcessLock, type ProcessLockOptions } from "./process-lock.js";

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
}

interface LinkRecord {
  hash: string;
  expiresAt: string;
}

interface SessionRecord {
  id: string;
  hash: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

const LinkFile = z.object({
  links: z.array(z.object({ hash: z.string(), expiresAt: z.string() })),
});

const SessionFile = z.object({
  sessions: z.array(
    z.object({
      id: z.string(),
      hash: z.string(),
      createdAt: z.string(),
      lastUsedAt: z.string(),
      expiresAt: z.string(),
    }),
  ),
});

interface SessionCache {
  mtimeMs: number;
  size: number;
  readAtMs: number;
  sessions: SessionRecord[];
  /** The file was unreadable or corrupt at this mtime and size. Verify fails closed. */
  failed: boolean;
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
  return { hash: row.hash, expiresAt: row.expiresAt };
}

function cleanSession(row: SessionRecord): SessionRecord {
  return {
    id: row.id,
    hash: row.hash,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
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

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
    opts: { lock?: ProcessLockOptions } = {},
  ) {
    const paths = dataRootPaths(root);
    this.linksPath = paths.browserLinks;
    this.sessionsPath = paths.browserSessions;
    this.authDir = paths.auth;
    this.lockPath = `${paths.auth}/.browser-session.lock`;
    this.lockOpts = opts.lock ?? {};
  }

  async createLink(): Promise<{ code: string; expiresAt: string }> {
    return this.mutate(async ({ links, sessions }) => {
      const nowMs = this.now();
      const code = `bl_${randomBytes(32).toString("base64url")}`;
      const expiresAt = new Date(nowMs + BROWSER_LINK_TTL_MS).toISOString();
      const nextLinks = roomForOne(pruneLinks(links, nowMs), MAX_LINKS);
      nextLinks.push({ hash: sha256Hex(code), expiresAt });
      await this.commit(nextLinks, pruneSessions(sessions, nowMs), { links, sessions });
      return { code, expiresAt };
    });
  }

  async redeemLink(code: string): Promise<{ token: string; session: BrowserSession } | null> {
    return this.mutate(async ({ links, sessions }) => {
      const nowMs = this.now();
      const liveLinks = pruneLinks(links, nowMs);
      const liveSessions = pruneSessions(sessions, nowMs);
      const match =
        typeof code === "string" && code.length > 0 ? findByHash(liveLinks, code) : null;
      if (!match) {
        await this.commit(liveLinks, liveSessions, { links, sessions });
        return null;
      }
      // Drop the link before the session is added, so a crash cannot leave it redeemable twice.
      const keptLinks = liveLinks.filter((link) => link !== match);
      const minted = this.mint(liveSessions, nowMs);
      await this.commit(keptLinks, minted.sessions, { links, sessions });
      return { token: minted.token, session: minted.session };
    });
  }

  async createSession(): Promise<{ token: string; session: BrowserSession }> {
    return this.mutate(async ({ links, sessions }) => {
      const nowMs = this.now();
      const minted = this.mint(pruneSessions(sessions, nowMs), nowMs);
      await this.commit(pruneLinks(links, nowMs), minted.sessions, { links, sessions });
      return { token: minted.token, session: minted.session };
    });
  }

  async verify(token: string | undefined): Promise<BrowserSession | null> {
    try {
      if (typeof token !== "string" || token.length === 0) return null;
      const sessions = await this.cachedSessions();
      if (!sessions) return null;
      const match = findByHash(sessions, token);
      if (!match) return null;
      const nowMs = this.now();
      if (sessionExpired(match, nowMs)) return null;
      if (nowMs - at(match.lastUsedAt) < TOUCH_MIN_MS) return toPublic(match);
      const updated = await this.touch(token, nowMs);
      return updated ? toPublic(updated) : null;
    } catch {
      if (!this.loggedUnexpected) {
        this.loggedUnexpected = true;
        this.logBad(this.sessionsPath);
      }
      return null;
    }
  }

  /** Delete every session and pending sign-in link; return the number of live sessions removed. */
  async revokeAll(): Promise<number> {
    return this.mutate(async ({ links, sessions, corrupt }) => {
      const liveCount = pruneSessions(sessions, this.now()).length;
      await this.commit([], [], { links, sessions }, corrupt);
      return liveCount;
    }, true);
  }

  private mint(
    sessions: SessionRecord[],
    nowMs: number,
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
    };
    next.push(record);
    return { token, session: toPublic(record), sessions: next };
  }

  /** Re-read under the lock and persist `lastUsedAt` when the session is still live. */
  private touch(token: string, nowMs: number): Promise<SessionRecord | null> {
    return this.mutate(async ({ links, sessions }) => {
      const liveLinks = pruneLinks(links, nowMs);
      const liveSessions = pruneSessions(sessions, nowMs);
      const match = findByHash(liveSessions, token);
      if (!match || nowMs - at(match.lastUsedAt) < TOUCH_MIN_MS) {
        await this.commit(liveLinks, liveSessions, { links, sessions });
        return match ?? null;
      }
      const updated: SessionRecord = { ...match, lastUsedAt: new Date(nowMs).toISOString() };
      const next = liveSessions.map((row) => (row === match ? updated : row));
      await this.commit(liveLinks, next, { links, sessions });
      return updated;
    });
  }

  private mutate<T>(
    fn: (state: {
      links: LinkRecord[];
      sessions: SessionRecord[];
      corrupt: { links: boolean; sessions: boolean };
    }) => Promise<T>,
    resetCorrupt = false,
  ): Promise<T> {
    return (async () => {
      await mkdir(this.authDir, { recursive: true, mode: 0o700 });
      return withProcessLock(
        this.lockPath,
        this.lockOpts,
        async () => {
          let links: LinkRecord[];
          let sessions: SessionRecord[];
          let linksCorrupt = false;
          let sessionsCorrupt = false;
          try {
            links = await this.readLinks();
          } catch (error) {
            if (!this.isCorrupt(error)) throw error;
            this.logBad(this.linksPath);
            if (!resetCorrupt) throw error;
            links = [];
            linksCorrupt = true;
          }
          try {
            sessions = await this.readSessions();
          } catch (error) {
            if (!this.isCorrupt(error)) throw error;
            this.logBad(this.sessionsPath);
            if (!resetCorrupt) throw error;
            sessions = [];
            sessionsCorrupt = true;
          }
          return fn({
            links,
            sessions,
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
    return (
      error instanceof Error && error.message.endsWith("is corrupt; not updating browser sessions")
    );
  }

  private async readLinks(): Promise<LinkRecord[]> {
    const rows = await this.readRecords(this.linksPath, (text) =>
      parseStored(text, LinkFile, "links"),
    );
    return rows.map(cleanLink);
  }

  private async readSessions(): Promise<SessionRecord[]> {
    const rows = await this.readRecords(this.sessionsPath, (text) =>
      parseStored(text, SessionFile, "sessions"),
    );
    return rows.map(cleanSession);
  }

  /** Missing file is an empty list. Anything else throws, without the file body in the message. */
  private async readRecords<T>(path: string, parse: (text: string) => T[]): Promise<T[]> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`${path} is unreadable; not updating browser sessions`);
    }
    try {
      return parse(text);
    } catch {
      throw new Error(`${path} is corrupt; not updating browser sessions`);
    }
  }

  private async commit(
    links: LinkRecord[],
    sessions: SessionRecord[],
    prev: { links: LinkRecord[]; sessions: SessionRecord[] },
    force: { links: boolean; sessions: boolean } = { links: false, sessions: false },
  ): Promise<void> {
    if (
      force.links ||
      JSON.stringify(links.map(cleanLink)) !== JSON.stringify(prev.links.map(cleanLink))
    ) {
      await this.persist(this.linksPath, { links: links.map(cleanLink) });
    }
    if (
      force.sessions ||
      JSON.stringify(sessions.map(cleanSession)) !== JSON.stringify(prev.sessions.map(cleanSession))
    ) {
      await this.persist(this.sessionsPath, { sessions: sessions.map(cleanSession) });
    }
  }

  private async persist(path: string, body: unknown): Promise<void> {
    await mkdir(this.authDir, { recursive: true, mode: 0o700 });
    await chmod(this.authDir, 0o700);
    // The process lock already serializes writers; avoid re-entering a non-reentrant file lock.
    await atomicWrite(path, `${JSON.stringify(body, null, 2)}\n`, 0o600);
    await chmod(path, 0o600);
    if (path === this.sessionsPath) this.cache = null;
  }

  /**
   * Stat on every call. Re-read files with a recent mtime to cover coarse timestamp resolution.
   * A failure is cached with that stat so a still-corrupt file logs once.
   */
  private async cachedSessions(): Promise<SessionRecord[] | null> {
    let fileStat: { mtimeMs: number; size: number };
    try {
      const st = await stat(this.sessionsPath);
      fileStat = { mtimeMs: st.mtimeMs, size: st.size };
      this.loggedStatError = false;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.cache = null;
        return [];
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
      return this.cache.failed ? null : this.cache.sessions;
    }

    try {
      const sessions = await this.readSessions();
      this.cache = { ...fileStat, readAtMs: Date.now(), sessions, failed: false };
      return sessions;
    } catch {
      const alreadyLogged =
        this.cache?.failed === true &&
        this.cache.mtimeMs === fileStat.mtimeMs &&
        this.cache.size === fileStat.size;
      this.cache = { ...fileStat, readAtMs: Date.now(), sessions: [], failed: true };
      if (!alreadyLogged) this.logBad(this.sessionsPath);
      return null;
    }
  }

  /** One line, and never the file body: a parser message would quote a secret if one were there. */
  private logBad(path: string, code?: string): void {
    console.error(
      `browser sessions: ${path} is unreadable or corrupt${code ? ` (${code})` : ""}; treating it as no sessions`,
    );
  }
}
