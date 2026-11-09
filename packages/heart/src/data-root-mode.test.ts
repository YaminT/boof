import { chmod, lstat, mkdir, mkdtemp, open, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSafeForSecrets, tightenDataRoot } from "./data-root-mode.js";
import { ToolRegistry } from "@boof/runner";

const roots: string[] = [];
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "boof-data-mode-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("tightenDataRoot", () => {
  it.skipIf(process.platform === "win32")("a 0755 root we own becomes 0700", async () => {
    const root = await temp();
    await chmod(root, 0o755);
    expect(await tightenDataRoot(root)).toEqual({ changed: true, before: 0o755 });
    expect((await stat(root)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("an already-private root is unchanged", async () => {
    expect(await tightenDataRoot(await temp())).toEqual({
      changed: false,
      reason: "already-private",
    });
  });

  it.skipIf(process.platform === "win32")(
    "tightens existing private subdirs and creates none",
    async () => {
      const root = await temp();
      await mkdir(join(root, "auth"), { mode: 0o777 });
      await chmod(join(root, "auth"), 0o777);
      expect(await tightenDataRoot(root)).toEqual({ changed: false, reason: "already-private" });
      expect((await stat(join(root, "auth"))).mode & 0o777).toBe(0o700);
      await expect(lstat(join(root, "owlish"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("never touches home or /", async () => {
    const root = await temp();
    await chmod(root, 0o755);
    expect(await tightenDataRoot(root, { home: root })).toEqual({
      changed: false,
      reason: "home-or-root",
    });
    expect(await tightenDataRoot("/", { home: root })).toEqual({
      changed: false,
      reason: "home-or-root",
    });
    expect((await stat(root)).mode & 0o777).toBe(0o755);
  });

  it("reports missing roots without throwing", async () => {
    expect(await tightenDataRoot(join(await temp(), "missing"))).toEqual({
      changed: false,
      reason: "missing",
    });
  });

  it.skipIf(process.platform === "win32")("returns not-owner when uid differs", async () => {
    const root = await temp();
    const owner = (await stat(root)).uid;
    expect(await tightenDataRoot(root, { uid: owner + 1 })).toEqual({
      changed: false,
      reason: "not-owner",
    });
  });

  it.skipIf(process.platform === "win32")(
    "does not chmod a root owned by another uid",
    async () => {
      const root = await temp();
      await chmod(root, 0o755);
      const owner = (await stat(root)).uid;
      expect(await tightenDataRoot(root, { uid: owner + 1 })).toEqual({
        changed: false,
        reason: "not-owner",
      });
      expect((await stat(root)).mode & 0o777).toBe(0o755);
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports root chmod failures without throwing",
    async () => {
      const root = await temp();
      await chmod(root, 0o755);
      const handle = await open(root, "r");
      const fileHandlePrototype = Object.getPrototypeOf(handle);
      await handle.close();
      vi.spyOn(fileHandlePrototype, "chmod").mockRejectedValue(
        Object.assign(new Error("permission denied"), { code: "EPERM" }),
      );
      expect(await tightenDataRoot(root)).toEqual({
        changed: false,
        reason: "chmod-failed",
        mode: 0o755,
      });
    },
  );

  it("windows is a no-op", async () => {
    expect(await tightenDataRoot("missing", { platform: "win32" })).toEqual({
      changed: false,
      reason: "windows",
    });
  });
});

describe("assertSafeForSecrets", () => {
  it.skipIf(process.platform === "win32")(
    "accepts the owned auth directory and regular file",
    async () => {
      const root = await temp();
      await mkdir(join(root, "auth"), { mode: 0o700 });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(root, "auth", "clients.json"), "{}", { mode: 0o600 });
      await expect(
        assertSafeForSecrets(root, join(root, "auth", "clients.json"), "file"),
      ).resolves.toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "removes group/world write from an owned data root",
    async () => {
      const root = await temp();
      await chmod(root, 0o775);
      await mkdir(join(root, "auth"), { mode: 0o700 });
      await expect(
        assertSafeForSecrets(root, join(root, "auth"), "directory"),
      ).resolves.toBeUndefined();
      expect((await stat(root)).mode & 0o777).toBe(0o755);
    },
  );

  it.skipIf(process.platform === "win32")("refuses group-writable auth directories", async () => {
    const root = await temp();
    const auth = join(root, "auth");
    await mkdir(auth, { mode: 0o700 });
    await chmod(auth, 0o770);
    await expect(assertSafeForSecrets(root, auth, "directory")).rejects.toThrow(/chmod 700/);
  });

  it.skipIf(process.platform === "win32")("refuses a symlinked secret file", async () => {
    const root = await temp();
    const auth = join(root, "auth");
    await mkdir(auth, { mode: 0o700 });
    const target = join(root, "outside.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, join(auth, "clients.json"));
    await expect(assertSafeForSecrets(root, join(auth, "clients.json"), "file")).rejects.toThrow(
      /regular file/,
    );
  });

  it.skipIf(process.platform === "win32")(
    "rejects roots below writable non-sticky ancestors",
    async () => {
      const root = await temp();
      const unsafeParent = join(root, "shared");
      await mkdir(unsafeParent, { mode: 0o777 });
      await chmod(unsafeParent, 0o777);
      const nested = join(unsafeParent, "data");
      await mkdir(nested, { mode: 0o700 });
      await mkdir(join(nested, "auth"), { mode: 0o700 });
      await expect(assertSafeForSecrets(nested, join(nested, "auth"), "directory")).rejects.toThrow(
        /ancestor/,
      );
    },
  );

  it.skipIf(process.platform === "win32")("checks owner of links in a symlink chain", async () => {
    const root = await temp();
    const real = join(root, "real");
    await mkdir(real, { mode: 0o700 });
    await mkdir(join(real, "auth"), { mode: 0o700 });
    const first = join(root, "first");
    const second = join(root, "second");
    await symlink(real, first);
    await symlink(first, second);
    await expect(
      assertSafeForSecrets(second, join(second, "auth"), "directory"),
    ).resolves.toBeUndefined();
    const uid = (await stat(root)).uid;
    await expect(
      assertSafeForSecrets(second, join(second, "auth"), "directory", { uid: uid + 1 }),
    ).rejects.toThrow(/symbolic link owned by uid/);
  });

  it.skipIf(process.platform === "win32")(
    "startServer tightens an open root and logs the change once",
    async () => {
      const root = await temp();
      await chmod(root, 0o755);
      const warnings: string[] = [];
      const { startServer } = await import("../../heart-server/src/server/server.js");
      const running = await startServer({
        root,
        port: 0,
        catalog: new ToolRegistry([]),
        warn: (message) => warnings.push(message),
      });
      try {
        expect((await stat(root)).mode & 0o777).toBe(0o700);
        expect(warnings.filter((message) => message.includes("tightened data root"))).toEqual([
          `tightened data root ${root} from 755 to 700 (other local users could read it)`,
        ]);
      } finally {
        await running.stop();
      }
    },
  );
});
