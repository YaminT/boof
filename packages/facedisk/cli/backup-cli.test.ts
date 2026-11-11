import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scaffoldDataRoot } from "@boof/heart";
import { backupCommand, restoreCommand } from "./backup-cli.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "boof-backup-cli-"));
  dirs.push(dir);
  return dir;
}

describe("backup and restore commands", () => {
  it("prints help without creating a data root", async () => {
    const logs: string[] = [];
    const root = join(await scratch(), "missing");
    const code = await backupCommand(
      ["--help"],
      () => {
        throw new Error("root");
      },
      (line) => logs.push(line),
      () => undefined,
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("--no-secrets");
    expect(existsSync(root)).toBe(false);
    const restoreLogs: string[] = [];
    expect(
      await restoreCommand(
        ["-h"],
        () => {
          throw new Error("root");
        },
        (line) => restoreLogs.push(line),
      ),
    ).toBe(0);
    expect(restoreLogs.join("\n")).toContain("--from");
  });

  it("requires --out, and restore requires --from and -d", async () => {
    const errs: string[] = [];
    const err = (line: string) => errs.push(line);
    expect(
      await backupCommand(
        [],
        () => "/nope",
        () => undefined,
        err,
      ),
    ).toBe(1);
    expect(errs.join("\n")).toContain("--out");
    errs.length = 0;
    expect(
      await restoreCommand(
        ["--from", "a.tar.gz"],
        () => "/nope",
        () => undefined,
        err,
      ),
    ).toBe(1);
    expect(errs.join("\n")).toContain("-d");
    errs.length = 0;
    expect(
      await restoreCommand(
        ["-d", "/tmp/x"],
        () => "/nope",
        () => undefined,
        err,
      ),
    ).toBe(1);
    expect(errs.join("\n")).toContain("--from");
  });

  it("backs up and restores through the commands and writes an audit line", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await scaffoldDataRoot(root);
    await writeFile(join(root, "notes.txt"), "hello");
    const archive = join(base, "root.tar.gz");
    const logs: string[] = [];
    const code = await backupCommand(
      ["--out", archive, "-d", root],
      () => root,
      (line) => logs.push(line),
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain(`Wrote`);
    expect(logs.join("\n")).toContain(archive);
    if (process.platform !== "win32") expect((await stat(archive)).mode & 0o777).toBe(0o600);
    expect(await auditText(root)).toContain("cli:backup");

    const dest = join(base, "restored");
    const restored: string[] = [];
    const restoreCode = await restoreCommand(
      ["--from", archive, "-d", dest],
      () => {
        throw new Error("restore must not default the data root");
      },
      (line) => restored.push(line),
    );
    expect(restoreCode).toBe(0);
    expect(restored.join("\n")).toBe(`Restored ${dest}`);
    expect(await readFile(join(dest, "notes.txt"), "utf8")).toBe("hello");
    expect(await auditText(dest)).toContain("cli:restore");
  });

  it("refuses a destination that already has a file", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await scaffoldDataRoot(root);
    const archive = join(base, "root.tar.gz");
    expect(await backupCommand(["-d", root, "--out", archive], () => root)).toBe(0);
    const dest = join(base, "occupied");
    await mkdir(dest);
    await writeFile(join(dest, "keep.txt"), "stay");
    const errs: string[] = [];
    const code = await restoreCommand(
      ["--from", archive, "-d", dest],
      () => root,
      () => undefined,
      (line) => errs.push(line),
    );
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("not empty");
    expect(await readFile(join(dest, "keep.txt"), "utf8")).toBe("stay");
  });
});

async function auditText(root: string): Promise<string> {
  const dir = join(root, "audit");
  const names = await readdir(dir);
  const parts = await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")));
  return parts.join("\n");
}
