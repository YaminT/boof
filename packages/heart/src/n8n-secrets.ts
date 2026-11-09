import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { lockedAtomicWrite, withFileLock } from "./atomic.js";
import { dataRootPaths } from "./paths.js";

const FileSchema = z.object({
  apiKey: z.string().optional(),
  webhookSecret: z.string().optional(),
});
type SecretFile = z.infer<typeof FileSchema>;
const TOLERATED = new Set(["ENOENT", "EPERM", "ENOTSUP", "EOPNOTSUPP"]);

async function tryChmod(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (err) {
    if (!TOLERATED.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
  }
}

/**
 * The n8n API key and the webhook header secret, kept out of settings.json:
 * `<data>/n8n/secrets.json` is `{ apiKey?, webhookSecret? }`, file 0600, folder 0700.
 * `BOOF_N8N_API_KEY` wins over the stored key and is never written.
 */
export class N8nSecretStore {
  private readonly path: string;

  constructor(
    root: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.path = dataRootPaths(root).n8nSecrets;
  }

  get filePath(): string {
    return this.path;
  }

  private async read(): Promise<SecretFile> {
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
      throw new Error("n8n/secrets.json is not valid JSON");
    }
    const parsed = FileSchema.safeParse(json);
    if (!parsed.success) throw new Error("n8n/secrets.json is not an object");
    return parsed.data;
  }

  private envKey(): string | null {
    const v = this.env.BOOF_N8N_API_KEY?.trim();
    return v ? v : null;
  }

  async getApiKey(): Promise<string | null> {
    const fromEnv = this.envKey();
    if (fromEnv) return fromEnv;
    const key = (await this.read()).apiKey;
    return key ? key : null;
  }

  async apiKeySource(): Promise<"env" | "file" | null> {
    if (this.envKey()) return "env";
    return (await this.read()).apiKey ? "file" : null;
  }

  setApiKey(key: string): Promise<void> {
    if (typeof key !== "string" || !/^[\x20-\x7e]{1,2048}$/.test(key))
      return Promise.reject(new Error("invalid n8n API key"));
    return this.mutate((f) => {
      f.apiKey = key;
    });
  }

  deleteApiKey(): Promise<void> {
    return this.mutate((f) => {
      delete f.apiKey;
    });
  }

  async getWebhookSecret(): Promise<string | null> {
    const s = (await this.read()).webhookSecret;
    return s ? s : null;
  }

  /** A new `n8nwh_` secret, stored; returned once. */
  async rotateWebhookSecret(): Promise<string> {
    const secret = "n8nwh_" + randomBytes(24).toString("hex");
    await this.mutate((f) => {
      f.webhookSecret = secret;
    });
    return secret;
  }

  deleteAll(): Promise<void> {
    return withFileLock(`${this.path}#mutate`, () => rm(this.path, { force: true }));
  }

  /** Bring an existing file to 0600 and its folder to 0700. */
  async tighten(): Promise<void> {
    await tryChmod(this.path, 0o600);
    await tryChmod(dirname(this.path), 0o700);
  }

  private mutate(fn: (f: SecretFile) => void): Promise<void> {
    return withFileLock(`${this.path}#mutate`, async () => {
      const file = await this.read();
      fn(file);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await tryChmod(dirname(this.path), 0o700);
      await lockedAtomicWrite(this.path, JSON.stringify(file, null, 2) + "\n", 0o600);
      await tryChmod(this.path, 0o600);
    });
  }
}
