import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyLinuxSandboxHelper } from "./stage-sandbox.mjs";
import { assertStagedNative } from "./staged-native.mjs";

const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "boof-staged-native-"));
  roots.push(dir);
  return dir;
}

describe("staged native files", () => {
  it("allows boof-sandbox and rejects every other native file", async () => {
    const app = await tempDir();
    await writeFile(join(app, "boof-sandbox"), elf);
    await writeFile(join(app, "main.js"), "console.log(1)\n");
    expect(() => assertStagedNative(app, "linux")).not.toThrow();
    expect(() => assertStagedNative(app, "darwin")).not.toThrow();

    await mkdir(join(app, "ui"));
    await writeFile(join(app, "ui", "addon.node"), elf);
    expect(() => assertStagedNative(app, "linux")).toThrow(/other than boof-sandbox/);
  });

  it("requires the helper on Linux and refuses a native file on other systems", async () => {
    const app = await tempDir();
    await writeFile(join(app, "main.js"), "console.log(1)\n");
    expect(() => assertStagedNative(app, "linux")).toThrow(/missing boof-sandbox/);
    expect(() => assertStagedNative(app, "win32")).not.toThrow();
    await writeFile(join(app, "claude.exe"), Buffer.from([0x4d, 0x5a, 0, 0]));
    expect(() => assertStagedNative(app, "win32")).toThrow(/other than boof-sandbox/);
  });
});

describe("copyLinuxSandboxHelper", () => {
  it("copies an executable helper on Linux and skips other systems", async () => {
    const root = await tempDir();
    const helper = join(root, "boof-sandbox");
    const app = join(root, "app");
    await writeFile(helper, elf);
    await chmod(helper, 0o755);
    await mkdir(app);
    expect(copyLinuxSandboxHelper({ platform: "darwin", helper, appDir: app })).toBeNull();
    expect(copyLinuxSandboxHelper({ platform: "linux", helper, appDir: app })).toBe(
      join(app, "boof-sandbox"),
    );
    const missing = join(root, "missing");
    expect(() =>
      copyLinuxSandboxHelper({ platform: "linux", helper: missing, appDir: app }),
    ).toThrow(/missing/);
  });
});
