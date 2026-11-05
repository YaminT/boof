import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { dataRootPaths, isAnthropicApiKey, lockedAtomicWrite, withProcessLock } from "@boof/heart";

const TOLERATED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOENT"]);
const tryChmod = async (path: string, mode: number) => {
  try {
    await chmod(path, mode);
  } catch (e) {
    if (!TOLERATED.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
  }
};
type ParsedKeys = { keys: Record<string, string>; invalid: Record<string, unknown> };
const warned = new Map<string, string>();
const parseFile = (text: string, path: string): ParsedKeys => {
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
  const keys = Object.create(null) as Record<string, string>;
  const invalid = Object.create(null) as Record<string, unknown>;
  let skipped = false;
  for (const [id, key] of Object.entries((value as { keys: Record<string, unknown> }).keys)) {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ||
      typeof key !== "string" ||
      !isAnthropicApiKey(key)
    ) {
      skipped = true;
      invalid[id] = key;
      continue;
    }
    keys[id] = key;
  }
  if (skipped && warned.get(path) !== text) {
    warned.set(path, text);
    console.warn("owlish/project-keys.json contains invalid entries; preserving them on write");
  }
  return { keys, invalid };
};

/** Project keys at rest (0600). Mutations are serialized across processes. */
export class ProjectKeyStore {
  private readonly path: string;
  constructor(root: string) {
    this.path = dataRootPaths(root).owlishProjectKeys;
  }
  private async read(): Promise<ParsedKeys> {
    try {
      return parseFile(await readFile(this.path, "utf8"), this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { keys: Object.create(null), invalid: Object.create(null) };
      if (e instanceof Error && e.message.startsWith("owlish/project-keys.json")) throw e;
      throw new Error("owlish/project-keys.json cannot be read");
    }
  }
  async get(projectId: string): Promise<string | null> {
    const { keys } = await this.read();
    return Object.hasOwn(keys, projectId) && typeof keys[projectId] === "string"
      ? keys[projectId]!
      : null;
  }
  async has(projectId: string): Promise<boolean> {
    return (await this.get(projectId)) !== null;
  }
  async set(projectId: string, key: string): Promise<void> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectId)) throw new Error("invalid project id");
    if (!isAnthropicApiKey(key)) throw new Error("project key must be an Anthropic API key");
    await withProcessLock(
      `${dirname(this.path)}/.project-keys.lock`,
      {},
      async () => {
        const { keys, invalid } = await this.read();
        keys[projectId] = key;
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await tryChmod(dirname(this.path), 0o700);
        await lockedAtomicWrite(
          this.path,
          JSON.stringify({ keys: { ...invalid, ...keys } }, null, 2) + "\n",
          0o600,
        );
        await tryChmod(this.path, 0o600);
      },
      (_holder, lock) =>
        new Error(`Another process is updating project keys; try again later (${lock})`),
    );
  }
  async delete(projectId: string): Promise<void> {
    await withProcessLock(
      `${dirname(this.path)}/.project-keys.lock`,
      {},
      async () => {
        const { keys, invalid } = await this.read();
        delete keys[projectId];
        if (Object.keys(keys).length + Object.keys(invalid).length === 0)
          await rm(this.path, { force: true });
        else
          await lockedAtomicWrite(
            this.path,
            JSON.stringify({ keys: { ...invalid, ...keys } }, null, 2) + "\n",
            0o600,
          );
      },
      (_holder, lock) =>
        new Error(`Another process is updating project keys; try again later (${lock})`),
    );
  }
  async tighten(): Promise<void> {
    await tryChmod(this.path, 0o600);
    await tryChmod(dirname(this.path), 0o700);
  }
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    variants.add(secret);
    variants.add(JSON.stringify(secret).slice(1, -1));
    variants.add(encodeURIComponent(secret));
  }
  for (const secret of [...variants].sort((a, b) => b.length - a.length))
    result = result.split(secret).join("[redacted]");
  result = result.replace(/sk-ant-[a-z]+\d{2}-[A-Za-z0-9_-]{8,}/g, "[redacted]");
  return result;
}
