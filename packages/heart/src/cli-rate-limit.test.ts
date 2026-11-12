import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI_BUSY_MAX_AGE_MS, cliRateLimitFile, takeCliTurn } from "./cli-rate-limit.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-cli-rate-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const take = (now: number) => takeCliTurn({ root, userId: "u", projectId: "p", limit: 1000, now });

describe("CLI busy mark", () => {
  it("expires a mark from another pid namespace once it is older than the limit", async () => {
    const t0 = 1_000_000_000_000;
    await mkdir(join(root, "ratelimit"), { recursive: true });
    await writeFile(
      cliRateLimitFile(root),
      JSON.stringify({
        rate: [],
        busy: [{ userId: "u", projectId: "p", pid: 999999, at: t0, ns: "other-namespace" }],
      }),
    );
    expect(await take(t0 + 1000)).toMatchObject({ ok: false, code: "concierge_busy" });
    const later = await take(t0 + CLI_BUSY_MAX_AGE_MS + 1);
    expect(later.ok).toBe(true);
    if (later.ok) await later.release();
    expect(JSON.parse(await readFile(cliRateLimitFile(root), "utf8")).busy).toEqual([]);
  });
});
