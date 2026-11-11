import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunTemp } from "@boof/runner";
import { boot, type Booted } from "./boot.js";

const linux = process.platform === "linux";
const required = process.env.BOOF_REQUIRE_SANDBOX === "1";
const gatewayKeys = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

describe.skipIf(!linux && !required)("crashed run temp at server start", () => {
  if (!linux) {
    it("fails closed when the Linux sandbox is required", () => {
      throw new Error("BOOF_REQUIRE_SANDBOX=1 but the Linux sandbox backend is absent");
    });
    return;
  }

  const saved = new Map<string, string | undefined>();
  const roots: string[] = [];

  afterEach(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("removes the crashed run directory and leaves home, cache and other data roots", async () => {
    const base = await mkdtemp(join(tmpdir(), "boof-i1e-boot-"));
    roots.push(base);
    const dataRoot = join(base, "data");
    const otherData = join(base, "other-data");
    const state = join(base, "state");
    await mkdir(dataRoot);
    await mkdir(otherData);
    await mkdir(state);
    for (const key of ["XDG_STATE_HOME", ...gatewayKeys]) {
      saved.set(key, process.env[key]);
    }
    process.env.XDG_STATE_HOME = state;
    for (const key of gatewayKeys) delete process.env[key];

    const temp = await createRunTemp({ dataRoot, projectId: "proj" });
    const project = dirname(dirname(temp));
    await mkdir(join(project, "home"), { recursive: true });
    await mkdir(join(project, "cache"), { recursive: true });
    await writeFile(join(project, "home", "keep.txt"), "home\n");
    await writeFile(join(project, "cache", "keep.txt"), "cache\n");
    await writeFile(join(temp, "marker.txt"), "gone\n");
    const otherTemp = await createRunTemp({ dataRoot: otherData, projectId: "proj" });
    await writeFile(join(otherTemp, "keep.txt"), "other\n");

    let booted: Booted | undefined;
    try {
      booted = await boot({
        root: dataRoot,
        version: "0.0.0-test",
        runner: false,
        port: 0,
        warn: () => {},
      });
      expect(booted.server.port).toBeGreaterThan(0);
      expect(existsSync(temp)).toBe(false);
      expect(existsSync(dirname(temp))).toBe(false);
      expect(await readFile(join(project, "home", "keep.txt"), "utf8")).toBe("home\n");
      expect(await readFile(join(project, "cache", "keep.txt"), "utf8")).toBe("cache\n");
      expect(await readFile(join(otherTemp, "keep.txt"), "utf8")).toBe("other\n");
      await expect(stat(temp)).rejects.toThrow();
    } finally {
      await booted?.stop(1000);
    }
  }, 30_000);
});
