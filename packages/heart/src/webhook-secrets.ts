import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { lockedAtomicWrite, withFileLock } from "./atomic.js";
import { dataRootPaths } from "./paths.js";

const FileSchema = z.record(z.string(), z.unknown());
const TOLERATED = new Set(["ENOENT", "EPERM", "ENOTSUP", "EOPNOTSUPP"]);

/** chmod that skips a missing path and filesystems that refuse modes (vfat). */
async function tryChmod(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (err) {
    if (!TOLERATED.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
  }
}

/** Is `secret` usable to sign with? */
export const isUsableSecret = (secret: unknown): secret is string =>
  typeof secret === "string" && secret.length >= 16;

/**
 * Webhook signing secrets, kept apart from settings.json so settings reads and copies never carry
 * them: `<data>/webhooks/secrets.json` is `{ "<webhook id>": "whsec_…" }`, mode 0600 (on POSIX filesystems).
 */
export class WebhookSecretStore {
  private readonly path: string;

  constructor(root: string) {
    this.path = dataRootPaths(root).webhookSecrets;
  }

  get filePath(): string {
    return this.path;
  }

  async all(): Promise<Record<string, string>> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    // Never echo the parser's message: it quotes the start of the file, i.e. a secret.
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("webhooks/secrets.json is not valid JSON");
    }
    const parsed = FileSchema.safeParse(json);
    if (!parsed.success) throw new Error("webhooks/secrets.json is not an object");
    // An unusable entry (empty, short, not a string) reads as missing, so delivery refuses it.
    return Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => isUsableSecret(v)),
    ) as Record<string, string>;
  }

  async get(id: string): Promise<string | null> {
    const all = await this.all();
    return Object.hasOwn(all, id) ? all[id] : null;
  }

  /** Bring an existing file to 0600 and its directory to 0700 (a restored copy may be looser). */
  async tighten(): Promise<void> {
    await tryChmod(this.path, 0o600);
    await tryChmod(dirname(this.path), 0o700);
  }

  set(id: string, secret: string): Promise<void> {
    return this.mutate((map) => {
      map[id] = secret;
    });
  }

  delete(id: string): Promise<void> {
    return this.mutate((map) => {
      delete map[id];
    });
  }

  private mutate(fn: (map: Record<string, string>) => void): Promise<void> {
    return withFileLock(`${this.path}#mutate`, async () => {
      const map = await this.all();
      fn(map);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await lockedAtomicWrite(this.path, JSON.stringify(map, null, 2) + "\n", 0o600);
      await tryChmod(this.path, 0o600);
    });
  }
}
