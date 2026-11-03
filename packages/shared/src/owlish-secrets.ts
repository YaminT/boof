import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { lockedAtomicWrite, withFileLock } from "./atomic.js";
import { dataRootPaths } from "./paths.js";

const FileSchema = z.object({ apiKey: z.unknown().optional() }).passthrough();
const TOLERATED = new Set(["ENOENT", "EPERM", "ENOTSUP", "EOPNOTSUPP"]);
const MAX_KEY = 512;

async function tryChmod(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (err) {
    if (!TOLERATED.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
  }
}

/** A usable client key: printable, no whitespace, not absurdly long. */
const usable = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_KEY && /^[\x21-\x7e]+$/.test(v);

/**
 * boof's one better-ccflare client key, kept apart from settings.json so settings reads and copies
 * never carry it: `<data>/owlish/secrets.json` is `{ "apiKey": "btr-…" }`, mode 0600 (POSIX), or
 * the environment variable `BOOF_OWLISH_API_KEY`, which wins and is never written. The key is
 * never put into an error message: a damaged file is reported without quoting it.
 */
export class OwlishSecretStore {
  private readonly path: string;

  constructor(
    root: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.path = dataRootPaths(root).owlishSecrets;
  }

  get filePath(): string {
    return this.path;
  }

  private envKey(): string | null {
    const v = this.env.BOOF_OWLISH_API_KEY?.trim();
    return v ? v : null;
  }

  private async fileKey(): Promise<string | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("owlish/secrets.json cannot be read");
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("owlish/secrets.json is not valid JSON");
    }
    const parsed = FileSchema.safeParse(json);
    if (!parsed.success) throw new Error("owlish/secrets.json is not an object");
    return usable(parsed.data.apiKey) ? parsed.data.apiKey : null;
  }

  /** The effective key (environment first), or null. */
  async get(): Promise<string | null> {
    return this.envKey() ?? (await this.fileKey());
  }

  /** Where the effective key comes from; the key itself is never revealed by this. */
  async source(): Promise<"env" | "file" | null> {
    if (this.envKey()) return "env";
    return (await this.fileKey()) ? "file" : null;
  }

  async set(key: string): Promise<void> {
    if (!usable(key)) {
      throw new Error(`the client key must be 1-${MAX_KEY} printable characters without spaces`);
    }
    await withFileLock(`${this.path}#mutate`, async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await lockedAtomicWrite(this.path, JSON.stringify({ apiKey: key }, null, 2) + "\n", 0o600);
      await tryChmod(this.path, 0o600);
    });
  }

  async delete(): Promise<void> {
    await withFileLock(`${this.path}#mutate`, () => rm(this.path, { force: true }));
  }

  /** Bring an existing file to 0600 and its directory to 0700 (a restored copy may be looser). */
  async tighten(): Promise<void> {
    await tryChmod(this.path, 0o600);
    await tryChmod(dirname(this.path), 0o700);
  }
}
