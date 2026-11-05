import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { dataRootPaths, isAnthropicApiKey, lockedAtomicWrite, withFileLock } from "@boof/heart";

const TOLERATED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP"]);
const tryChmod = async (path: string, mode: number) => {
  try {
    await chmod(path, mode);
  } catch (e) {
    if (!TOLERATED.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
  }
};
const parseFile = (text: string): Record<string, string> => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("owlish/project-keys.json is not valid JSON");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("keys" in value) ||
    !value.keys ||
    typeof value.keys !== "object" ||
    Array.isArray(value.keys)
  )
    throw new Error("owlish/project-keys.json is not an object");
  const keys = (value as { keys: Record<string, unknown> }).keys;
  for (const [id, key] of Object.entries(keys))
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !isAnthropicApiKey(key))
      throw new Error("owlish/project-keys.json contains invalid data");
  return keys as Record<string, string>;
};

/** Project API keys, kept only in `<data>/owlish/project-keys.json` (mode 0600). */
export class ProjectKeyStore {
  private readonly path: string;
  constructor(root: string, _env: NodeJS.ProcessEnv = process.env) {
    this.path = dataRootPaths(root).owlishProjectKeys;
  }
  private async read(): Promise<Record<string, string>> {
    try {
      return parseFile(await readFile(this.path, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      if (e instanceof Error && e.message.startsWith("owlish/project-keys.json")) throw e;
      throw new Error("owlish/project-keys.json cannot be read");
    }
  }
  async get(projectId: string): Promise<string | null> {
    return (await this.read())[projectId] ?? null;
  }
  async has(projectId: string): Promise<boolean> {
    return (await this.get(projectId)) !== null;
  }
  async set(projectId: string, key: string): Promise<void> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectId)) throw new Error("invalid project id");
    if (!isAnthropicApiKey(key)) throw new Error("project key must be an Anthropic API key");
    await withFileLock(`${this.path}#mutate`, async () => {
      const keys = await this.read();
      keys[projectId] = key;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await tryChmod(dirname(this.path), 0o700);
      await lockedAtomicWrite(this.path, JSON.stringify({ keys }, null, 2) + "\n", 0o600);
      await tryChmod(this.path, 0o600);
    });
  }
  async delete(projectId: string): Promise<void> {
    await withFileLock(`${this.path}#mutate`, async () => {
      const keys = await this.read();
      delete keys[projectId];
      if (Object.keys(keys).length === 0) await rm(this.path, { force: true });
      else await lockedAtomicWrite(this.path, JSON.stringify({ keys }, null, 2) + "\n", 0o600);
    });
  }
  async tighten(): Promise<void> {
    await tryChmod(this.path, 0o600);
    await tryChmod(dirname(this.path), 0o700);
  }
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets)
    if (secret.length >= 8) result = result.split(secret).join("[redacted]");
  return result;
}
