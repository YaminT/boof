import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageStore } from "./usage-store.js";
import { sumUsage, UNKNOWN_USAGE } from "./usage-math.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-usage-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("sumUsage", () => {
  it("is the unknown usage for nothing, and known when any part is", () => {
    expect(sumUsage([])).toEqual(UNKNOWN_USAGE);
    const total = sumUsage([
      { inputTokens: 1, outputTokens: 2, costUsd: 0.5, known: true },
      { inputTokens: 10, outputTokens: 20, costUsd: 0, known: false },
    ]);
    expect(total).toEqual({ inputTokens: 11, outputTokens: 22, costUsd: 0.5, known: true });
    expect(sumUsage([UNKNOWN_USAGE, UNKNOWN_USAGE]).known).toBe(false);
  });
});

describe("UsageStore", () => {
  it("starts unknown, accumulates across adds and persists", async () => {
    const store = new UsageStore(root);
    expect(await store.load()).toEqual(UNKNOWN_USAGE);
    await store.add({ inputTokens: 5, outputTokens: 1, costUsd: 0.25, known: true });
    const total = await store.add({ inputTokens: 5, outputTokens: 1, costUsd: 0, known: false });
    expect(total).toEqual({ inputTokens: 10, outputTokens: 2, costUsd: 0.25, known: true });
    expect(await new UsageStore(root).load()).toEqual(total);
  });

  it("treats a corrupt file as unknown usage", async () => {
    await writeFile(join(root, "usage.json"), "{not json");
    expect(await new UsageStore(root).load()).toEqual(UNKNOWN_USAGE);
  });
});
