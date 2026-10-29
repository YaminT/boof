import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { lockedAtomicWrite, withFileLock } from "./atomic.js";
import { dataRootPaths } from "./paths.js";

/**
 * Webhook signing secrets, kept apart from settings.json so settings reads and copies never carry
 * them: `<data>/webhooks/secrets.json` is `{ "<webhook id>": "whsec_…" }`, mode 0600.
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
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<string, string>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  async get(id: string): Promise<string | null> {
    return (await this.all())[id] ?? null;
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
      await chmod(this.path, 0o600);
    });
  }
}
