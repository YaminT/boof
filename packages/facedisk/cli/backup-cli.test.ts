import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStore, scaffoldDataRoot } from "@boof/heart";
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
    expect(restoreLogs.join("\n")).toContain("corruption");
    expect(restoreLogs.join("\n")).not.toContain("tampered file");
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
    await new AuthStore(root).create({ name: "ci", scopes: ["tasks:read"] });
    const archive = join(base, "root.tar.gz");
    const logs: string[] = [];
    const warnings: string[] = [];
    const code = await backupCommand(
      ["--out", archive, "-d", root],
      () => root,
      (line) => logs.push(line),
      (line) => warnings.push(line),
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain(`Wrote`);
    expect(logs.join("\n")).toContain(archive);
    expect(warnings.join("\n")).toContain("archive contains API keys and signing secrets");
    if (process.platform !== "win32") expect((await stat(archive)).mode & 0o777).toBe(0o600);
    expect(await auditText(root)).toContain("cli:backup");

    const dest = join(base, "restored");
    const restored: string[] = [];
    const restoreWarnings: string[] = [];
    const restoreCode = await restoreCommand(
      ["--from", archive, "-d", dest],
      () => {
        throw new Error("restore must not default the data root");
      },
      (line) => restored.push(line),
      (line) => restoreWarnings.push(line),
    );
    expect(restoreCode).toBe(0);
    expect(restored.join("\n")).toContain(`Restored ${dest}`);
    expect(restored.join("\n")).toContain("revoked after this backup come back");
    expect(restored.join("\n")).toContain("boof-runner auth revoke");
    expect(restored.join("\n")).toContain("boof-runner open --revoke-all");
    expect(restoreWarnings.join("\n")).toContain("archives you created and trust");
    expect(await readFile(join(dest, "notes.txt"), "utf8")).toBe("hello");
    expect(await auditText(dest)).toContain("cli:restore");
  });

  it("does not claim plaintext secrets are present when --no-secrets is used", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await scaffoldDataRoot(root);
    const warnings: string[] = [];
    const code = await backupCommand(
      ["--no-secrets", "--out", join(base, "nosecrets.tar.gz"), "-d", root],
      () => root,
      () => undefined,
      (line) => warnings.push(line),
    );
    expect(code).toBe(0);
    expect(warnings.join("\n")).not.toContain("archive contains API keys");
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

  it("does not write a restore failure audit into a refused live data root", async () => {
    const base = await scratch();
    const source = join(base, "source");
    await scaffoldDataRoot(source);
    const archive = join(base, "source.tar.gz");
    expect(
      await backupCommand(
        ["-d", source, "--out", archive],
        () => source,
        () => undefined,
        () => undefined,
      ),
    ).toBe(0);

    const live = join(base, "live");
    await scaffoldDataRoot(live);
    const auditDir = join(live, "audit");
    const before = existsSync(auditDir) ? await auditText(live) : "";
    const errors: string[] = [];
    expect(
      await restoreCommand(
        ["--from", archive, "-d", live],
        () => live,
        () => undefined,
        (line) => errors.push(line),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toContain("not empty");
    expect(existsSync(auditDir) ? await auditText(live) : "").toBe(before);
  });

  it("lists only active clients, escapes control characters and names the real commands", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await scaffoldDataRoot(root);
    const store = new AuthStore(root);
    const active = await store.create({
      name: "\u001b]0;pwned\u0007\u001b[2JFAKE OK",
      scopes: ["tasks:read"],
    });
    const gone = await store.create({ name: "old-client", scopes: ["tasks:read"] });
    await store.revoke(gone.client.id);
    const archive = join(base, "a.tar.gz");
    expect(
      await backupCommand(
        ["-d", root, "--out", archive],
        () => root,
        () => undefined,
        () => undefined,
      ),
    ).toBe(0);
    const logs: string[] = [];
    expect(
      await restoreCommand(
        ["--from", archive, "-d", join(base, "dest")],
        () => root,
        (l) => logs.push(l),
        () => undefined,
      ),
    ).toBe(0);
    const text = logs.join("\n");
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(text).toContain("\\x1b]0;pwned\\x07");
    expect(text).toContain(active.client.id);
    expect(text).not.toContain("old-client");
    expect(text).toContain("boof-runner auth revoke");
    expect(text).toContain("boof-runner open --revoke-all");
  });

  it("prints no revocation notice when the archive has no auth data", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await scaffoldDataRoot(root);
    const archive = join(base, "n.tar.gz");
    expect(
      await backupCommand(
        ["--no-secrets", "-d", root, "--out", archive],
        () => root,
        () => undefined,
        () => undefined,
      ),
    ).toBe(0);
    const logs: string[] = [];
    expect(
      await restoreCommand(
        ["--from", archive, "-d", join(base, "dest")],
        () => root,
        (l) => logs.push(l),
        () => undefined,
      ),
    ).toBe(0);
    expect(logs.join("\n")).not.toContain("revoke");
  });

  it("exits 1 and publishes nothing when auth/clients.json in the archive is broken", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await scaffoldDataRoot(root);
    await mkdir(join(root, "auth"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "auth", "clients.json"), '{"clients":[{"id":"x"}]}', {
      mode: 0o600,
    });
    const archive = join(base, "b.tar.gz");
    expect(
      await backupCommand(
        ["-d", root, "--out", archive],
        () => root,
        () => undefined,
        () => undefined,
      ),
    ).toBe(0);
    const dest = join(base, "dest");
    const errs: string[] = [];
    expect(
      await restoreCommand(
        ["--from", archive, "-d", dest],
        () => root,
        () => undefined,
        (l) => errs.push(l),
      ),
    ).toBe(1);
    expect(errs.join("\n")).toContain("auth/clients.json");
    expect(existsSync(dest)).toBe(false);
    expect((await readdir(base)).filter((n) => n.startsWith(".boof-restore-"))).toEqual([]);
  });
});

async function auditText(root: string): Promise<string> {
  const dir = join(root, "audit");
  const names = await readdir(dir);
  const parts = await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")));
  return parts.join("\n");
}
