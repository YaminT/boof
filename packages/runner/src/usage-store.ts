import { stat } from "node:fs/promises";
import { join } from "node:path";
import { lockedAtomicWrite, readText, type TokenUsage } from "@boof-claw/shared";
import { sumUsage, UNKNOWN_USAGE } from "./tools/usage.js";

/** Global token-usage aggregate, persisted at <data-root>/usage.json. */
export class UsageStore {
  private readonly path: string;
  constructor(root: string) {
    this.path = join(root, "usage.json");
  }

  async load(): Promise<TokenUsage> {
    try {
      await stat(this.path);
      return JSON.parse(await readText(this.path)) as TokenUsage;
    } catch {
      return { ...UNKNOWN_USAGE };
    }
  }

  /** Add a task's usage to the global aggregate. */
  async add(usage: TokenUsage): Promise<TokenUsage> {
    const current = await this.load();
    const total = sumUsage([current, usage]);
    await lockedAtomicWrite(this.path, JSON.stringify(total, null, 2) + "\n");
    return total;
  }
}
