import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { lockedAtomicWrite } from "./atomic.js";
import { withProcessLock, type ProcessLockOptions } from "./process-lock.js";
import { uniqueKebabId } from "./ids.js";
import { dataRootPaths } from "./paths.js";
import {
  ClientSchema,
  type Client,
  type ClientKind,
  type PublicClient,
  type Scope,
  type Trust,
} from "./schema.js";

const FileSchema = z.object({ clients: z.array(ClientSchema) });

const KEY_PREFIX = "boof_";

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Build the key shown to the user: `boof_<clientId>_<base64url(secret)>`. */
export function formatKey(clientId: string, secret: string): string {
  return `${KEY_PREFIX}${clientId}_${secret}`;
}

/** Split a presented key into client id and secret, or null if malformed. */
export function parseKey(key: string): { clientId: string; secret: string } | null {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const rest = key.slice(KEY_PREFIX.length);
  // Kebab ids contain no underscore, so the first underscore ends the id.
  const i = rest.indexOf("_");
  if (i <= 0 || i === rest.length - 1) return null;
  return { clientId: rest.slice(0, i), secret: rest.slice(i + 1) };
}

export function toPublicClient(client: Client): PublicClient {
  const { keyHash: _keyHash, ...rest } = client;
  return rest;
}

export type VerifyResult =
  | { ok: true; client: Client }
  | { ok: false; reason: "malformed" | "unknown" | "bad_secret" | "revoked" | "expired" };

export interface CreateClientInput {
  name: string;
  kind?: ClientKind;
  scopes: Scope[];
  projects?: "*" | string[];
  trust?: Trust;
  /** ISO timestamp. */
  expiresAt?: string;
  /**
   * Always append a random suffix to the id (`name-1a2b3c`). The API sets it: a bare name when it
   * is free and a suffix when it is taken would tell a caller that cannot see every client which
   * names exist.
   */
  randomSuffix?: boolean;
}

/** Reserved: the id the removed keyless local-mcp principal had. No client may hold it. */
export const LOCAL_MCP_ID = "local-mcp";

/** `local` names the local principal and `local-mcp` the removed keyless MCP one, so no client may hold either id. */
const RESERVED_CLIENT_IDS = ["local", LOCAL_MCP_ID];

/**
 * The warning for a client that holds the reserved id `local-mcp` from before it was reserved: it
 * cannot authenticate any more. Undefined when there is none (a revoked one is already refused).
 */
export function reservedIdWarning(clients: readonly Client[]): string | undefined {
  if (!clients.some((c) => c.id === LOCAL_MCP_ID && !c.revokedAt)) return undefined;
  return (
    `warning: auth/clients.json holds a client with the reserved id ${LOCAL_MCP_ID} (made before the id was reserved). ` +
    `It is refused. Fix: boof-runner auth revoke ${LOCAL_MCP_ID}`
  );
}

/** Tighten an existing `auth/` directory (an older data root may have it looser) to mode 0700. */
export async function tightenAuthDir(root: string): Promise<void> {
  try {
    await chmod(dataRootPaths(root).auth, 0o700);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Parse "30d", "12h", "90m" into a duration in ms. */
export function parseDuration(text: string): number {
  const m = /^(\d+)([smhdw])$/.exec(text.trim());
  if (!m) throw new Error(`Invalid duration: ${text} (use e.g. 30d, 12h)`);
  const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2] as "s"];
  return Number(m[1]) * unit;
}

export function isExpired(client: Pick<Client, "expiresAt">, nowMs: number): boolean {
  return client.expiresAt !== undefined && Date.parse(client.expiresAt) <= nowMs;
}

/**
 * File-backed client registry at <data>/auth/clients.json (mode 0600). Only the
 * sha256 of each secret is stored; the secret is returned once at creation or
 * rotation. Secrets are 32 random bytes, so a plain sha256 is sufficient.
 */
export class AuthStore {
  private readonly path: string;
  private readonly dir: string;
  /** Bumped on every write by this instance; lets in-process caches invalidate at once. */
  version = 0;

  private readonly lockOpts: ProcessLockOptions;

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
    opts: { lock?: ProcessLockOptions } = {},
  ) {
    const p = dataRootPaths(root);
    this.path = p.authClients;
    this.dir = p.auth;
    this.lockOpts = opts.lock ?? {};
  }

  get filePath(): string {
    return this.path;
  }

  /** mtime (ms) of clients.json, or 0 when it does not exist. */
  async mtimeMs(): Promise<number> {
    try {
      return (await stat(this.path)).mtimeMs;
    } catch {
      return 0;
    }
  }

  async list(): Promise<Client[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return FileSchema.parse(JSON.parse(raw)).clients;
  }

  async get(id: string): Promise<Client | null> {
    if (id.startsWith("concierge-")) return null;
    return (await this.list()).find((c) => c.id === id) ?? null;
  }

  /** True when at least one client is neither revoked nor expired. */
  async hasActiveClient(): Promise<boolean> {
    const t = this.now();
    return (await this.list()).some((c) => !c.revokedAt && !isExpired(c, t));
  }

  private async save(clients: Client[]): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await lockedAtomicWrite(this.path, JSON.stringify({ clients }, null, 2) + "\n", 0o600);
    await chmod(this.path, 0o600);
    this.version += 1;
  }

  /**
   * Read-modify-write under `auth/.clients.lock`, so the CLI, the server and the desktop never
   * overwrite each other: a revoke made by one process is not undone by another's `lastUsedAt`
   * write. The lock also queues callers inside this process. A holder that is gone is taken over.
   */
  private async mutate<T>(fn: (clients: Client[]) => T): Promise<T> {
    // The directory first, with its private mode: the lock file is created inside it.
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    return withProcessLock(
      join(this.dir, ".clients.lock"),
      this.lockOpts,
      async () => {
        const clients = await this.list();
        const out = fn(clients);
        await this.save(clients);
        return out;
      },
      (holder, path) =>
        new Error(
          `Another boof process is updating the API clients (pid ${holder}); try again in a moment, or remove ${path} if no boof process is running`,
        ),
    );
  }

  async create(input: CreateClientInput): Promise<{ client: PublicClient; key: string }> {
    const secret = randomBytes(32).toString("base64url");
    return this.mutate((clients) => {
      const taken = new Set([...clients.map((c) => c.id), ...RESERVED_CLIENT_IDS]);
      // `concierge-` names the in-memory assistant principal. A stored client never gets it:
      // a base id that starts with `concierge` is issued as `client-<base>`.
      let base = uniqueKebabId(input.name, []);
      if (base.startsWith("concierge")) base = `client-${base}`;
      let id = input.randomSuffix ? `${base}-${randomBytes(3).toString("hex")}` : base;
      // A taken id gets a random suffix, not "-2" (see `randomSuffix`).
      while (taken.has(id))
        id = `${base}-${randomBytes(input.randomSuffix ? 3 : 2).toString("hex")}`;
      const client: Client = ClientSchema.parse({
        id,
        name: input.name,
        kind: input.kind ?? "harness",
        keyHash: sha256Hex(secret),
        scopes: input.scopes,
        projects: input.projects ?? "*",
        trust: input.trust ?? "review",
        created: new Date(this.now()).toISOString(),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      });
      clients.push(client);
      return { client: toPublicClient(client), key: formatKey(id, secret) };
    });
  }

  async revoke(id: string): Promise<PublicClient | null> {
    return this.mutate((clients) => {
      const c = clients.find((x) => x.id === id);
      if (!c) return null;
      c.revokedAt ??= new Date(this.now()).toISOString();
      return toPublicClient(c);
    });
  }

  /** Issue a new secret; the old one stops working immediately. Revoked clients cannot rotate. */
  async rotate(id: string): Promise<{ client: PublicClient; key: string } | null> {
    const secret = randomBytes(32).toString("base64url");
    return this.mutate((clients) => {
      const c = clients.find((x) => x.id === id);
      if (!c || c.revokedAt) return null;
      c.keyHash = sha256Hex(secret);
      return { client: toPublicClient(c), key: formatKey(id, secret) };
    });
  }

  /** Record lastUsedAt. Callers throttle; this always writes. */
  async touch(id: string): Promise<void> {
    await this.mutate((clients) => {
      const c = clients.find((x) => x.id === id);
      if (c) c.lastUsedAt = new Date(this.now()).toISOString();
    });
  }

  /** Validate a presented key against a client list. Constant-time hash comparison. */
  verifyAgainst(clients: readonly Client[], key: string): VerifyResult {
    const parsed = parseKey(key);
    if (!parsed) return { ok: false, reason: "malformed" };
    // Legacy entries using the in-memory concierge principal namespace cannot authenticate, nor can a legacy `local-mcp` entry (reserved).
    const client = parsed.clientId.startsWith("concierge-")
      ? undefined
      : clients.find((c) => c.id === parsed.clientId && c.id !== LOCAL_MCP_ID);
    // Always hash and compare, even for unknown ids, so timing does not reveal existence.
    const presented = Buffer.from(sha256Hex(parsed.secret), "hex");
    const expected = Buffer.from(client?.keyHash ?? "0".repeat(64), "hex");
    const equal = timingSafeEqual(presented, expected);
    if (!client) return { ok: false, reason: "unknown" };
    if (!equal) return { ok: false, reason: "bad_secret" };
    if (client.revokedAt) return { ok: false, reason: "revoked" };
    if (isExpired(client, this.now())) return { ok: false, reason: "expired" };
    return { ok: true, client };
  }

  async verify(key: string): Promise<VerifyResult> {
    return this.verifyAgainst(await this.list(), key);
  }
}
