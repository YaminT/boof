import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { dataRootPaths, lockedAtomicWrite, withFileLock } from "@boof/heart";

const FileSchema = z
  .object({ apiKey: z.unknown().optional(), agentKey: z.unknown().optional() })
  .passthrough();

type Field = "apiKey" | "agentKey";
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
 * boof's better-ccflare keys, kept apart from settings.json so settings reads and copies
 * never carry it: `<data>/owlish/secrets.json` is `{ "apiKey": "btr-…" }`, mode 0600 (POSIX), or
 * the environment variable `BOOF_OWLISH_API_KEY`, which wins and is never written. The same file
 * holds `agentKey`, the api-only key that claude-agent processes use (`BOOF_OWLISH_AGENT_KEY`);
 * the admin `apiKey` never leaves boof. The key is
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

  private envKey(field: Field): string | null {
    const v =
      this.env[field === "apiKey" ? "BOOF_OWLISH_API_KEY" : "BOOF_OWLISH_AGENT_KEY"]?.trim();
    return v ? v : null;
  }

  private async readFileObject(): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
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
    return parsed.data;
  }

  private async fileKey(field: Field): Promise<string | null> {
    const value = (await this.readFileObject())[field];
    return usable(value) ? value : null;
  }

  private async setField(field: Field, key: string): Promise<void> {
    if (!usable(key)) {
      throw new Error(`the key must be 1-${MAX_KEY} printable characters without spaces`);
    }
    await withFileLock(`${this.path}#mutate`, async () => {
      // Refuse when the current file is unreadable: replacing it could silently discard
      // the other credential, and either key may be needed independently.
      const current = await this.readFileObject();
      const otherField = field === "apiKey" ? "agentKey" : "apiKey";
      const otherEnv = this.envKey(otherField);
      const otherStored = usable(current[otherField]) ? current[otherField] : null;
      const other = otherEnv ?? otherStored;
      if (
        other &&
        key.length === other.length &&
        timingSafeEqual(Buffer.from(key), Buffer.from(other))
      ) {
        throw new Error(
          "the agent key must be a separate api-only better-ccflare key, not the admin client key",
        );
      }
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await lockedAtomicWrite(
        this.path,
        JSON.stringify({ ...current, [field]: key }, null, 2) + "\n",
        0o600,
      );
      await tryChmod(this.path, 0o600);
    });
  }

  private async deleteField(field: Field): Promise<void> {
    await withFileLock(`${this.path}#mutate`, async () => {
      const current = await this.readFileObject().catch(() => null);
      if (current === null) return void (await rm(this.path, { force: true }));
      delete current[field];
      const left = Object.keys(current).filter((k) => usable(current[k]));
      if (left.length === 0) return void (await rm(this.path, { force: true }));
      await lockedAtomicWrite(this.path, JSON.stringify(current, null, 2) + "\n", 0o600);
      await tryChmod(this.path, 0o600);
    });
  }

  /** The effective admin client key (environment first), or null. */
  async get(): Promise<string | null> {
    return this.envKey("apiKey") ?? (await this.fileKey("apiKey"));
  }

  /** Where the effective key comes from; the key itself is never revealed by this. */
  async source(): Promise<"env" | "file" | null> {
    if (this.envKey("apiKey")) return "env";
    return (await this.fileKey("apiKey")) ? "file" : null;
  }

  async set(key: string): Promise<void> {
    return this.setField("apiKey", key);
  }

  async delete(): Promise<void> {
    return this.deleteField("apiKey");
  }

  /** The effective api-only agent key for claude-agent (environment first), or null. */
  async getAgent(): Promise<string | null> {
    return this.envKey("agentKey") ?? (await this.fileKey("agentKey"));
  }

  async agentSource(): Promise<"env" | "file" | null> {
    if (this.envKey("agentKey")) return "env";
    return (await this.fileKey("agentKey")) ? "file" : null;
  }

  async setAgent(key: string): Promise<void> {
    return this.setField("agentKey", key);
  }

  async deleteAgent(): Promise<void> {
    return this.deleteField("agentKey");
  }

  /** Bring an existing file to 0600 and its directory to 0700 (a restored copy may be looser). */
  async tighten(): Promise<void> {
    await tryChmod(this.path, 0o600);
    await tryChmod(dirname(this.path), 0o700);
  }
}
