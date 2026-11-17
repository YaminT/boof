import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { lockedAtomicWrite, withFileLock } from "@boof/heart";

export const PROVIDER = "claude-console-api" as const;

/** An Anthropic Console API key, the only credential the internal pool accepts. */
export const isAnthropicApiKey = (v: unknown): v is string =>
  typeof v === "string" && /^sk-ant-api[0-9]{0,3}-[A-Za-z0-9_-]{8,512}$/.test(v);

export interface AccountRecord {
  id: string;
  name: string;
  provider: typeof PROVIDER;
  apiKey: string;
  /** 0 to 100; the lowest number is used first. */
  priority: number;
  createdAt: string;
}

/** Runtime state; carries no key. Times are epoch ms. */
export interface AccountState {
  paused: boolean;
  pauseReason: "manual" | "auth" | null;
  rateLimitedUntil: number | null;
  usageExhaustedAt: number | null;
  lastUsed: number | null;
  requestCount: number;
  lastStatus: number | null;
  inputTokens: number;
  outputTokens: number;
}

export const freshState = (): AccountState => ({
  paused: false,
  pauseReason: null,
  rateLimitedUntil: null,
  usageExhaustedAt: null,
  lastUsed: null,
  requestCount: 0,
  lastStatus: null,
  inputTokens: 0,
  outputTokens: 0,
});

const AccountSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  provider: z.literal(PROVIDER),
  apiKey: z.custom<string>(isAnthropicApiKey),
  priority: z.number().int().min(0).max(100),
  createdAt: z.string(),
});
const AccountsFile = z.object({ version: z.literal(1), accounts: z.array(AccountSchema) });

const count = z.number().int().min(0).catch(0);
const time = z.number().finite().nullable().catch(null);
const StateSchema = z.object({
  paused: z.boolean().catch(false),
  pauseReason: z.enum(["manual", "auth"]).nullable().catch(null),
  rateLimitedUntil: time,
  usageExhaustedAt: time,
  lastUsed: time,
  requestCount: count,
  lastStatus: z.number().int().nullable().catch(null),
  inputTokens: count,
  outputTokens: count,
});
const StateFile = z.object({ version: z.literal(1), accounts: z.record(z.string(), StateSchema) });

const TOLERATED = new Set(["ENOENT", "EPERM", "ENOTSUP", "EOPNOTSUPP"]);

async function tryChmod(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (err) {
    if (!TOLERATED.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
  }
}

async function readJson(path: string, label: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${label} cannot be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    // Never quote the file: it may hold keys.
    throw new Error(`${label} is not valid JSON`);
  }
}

/**
 * `<dir>/accounts.json` (keys, mode 0600, directory 0700) and `<dir>/state.json` (pause and
 * reset state, no keys). `dir` is `<data>/gateway`. Contents are never put into an error message.
 */
export class AccountsStore {
  readonly accountsPath: string;
  readonly statePath: string;

  constructor(readonly dir: string) {
    this.accountsPath = join(dir, "accounts.json");
    this.statePath = join(dir, "state.json");
  }

  async loadAccounts(): Promise<AccountRecord[]> {
    const json = await readJson(this.accountsPath, "gateway/accounts.json");
    if (json === undefined) return [];
    const parsed = AccountsFile.safeParse(json);
    if (!parsed.success) throw new Error("gateway/accounts.json has an unexpected shape");
    return parsed.data.accounts;
  }

  async saveAccounts(accounts: AccountRecord[]): Promise<void> {
    await this.write(this.accountsPath, JSON.stringify({ version: 1, accounts }, null, 2) + "\n");
  }

  /** State by account id; a damaged state file is dropped (it only holds soft state). */
  async loadState(): Promise<Map<string, AccountState>> {
    let json: unknown;
    try {
      json = await readJson(this.statePath, "gateway/state.json");
    } catch {
      return new Map();
    }
    const parsed = StateFile.safeParse(json);
    return new Map(parsed.success ? Object.entries(parsed.data.accounts) : []);
  }

  async saveState(state: Map<string, AccountState>): Promise<void> {
    await this.write(
      this.statePath,
      JSON.stringify({ version: 1, accounts: Object.fromEntries(state) }, null, 2) + "\n",
    );
  }

  private async write(path: string, text: string): Promise<void> {
    await withFileLock(`${path}#mutate`, async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await lockedAtomicWrite(path, text, 0o600);
      await tryChmod(path, 0o600);
    });
  }

  /** Bring existing files to 0600 and the directory to 0700 (a restored copy may be looser). */
  async tighten(): Promise<void> {
    await tryChmod(this.accountsPath, 0o600);
    await tryChmod(this.statePath, 0o600);
    await tryChmod(this.dir, 0o700);
  }
}
