import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { linuxSandboxSuite, makeFixture, runProbe } from "./accept-support.js";

linuxSandboxSuite("sandbox acceptance: data root and host files", () => {
  it("A1 denies reads of settings.json, auth/ and n8n/secrets.json", async () => {
    const fx = await makeFixture();
    const visible = await runProbe(fx, ["read", join(fx.wt.path, "visible.txt")]);
    expect(visible.code, visible.stderr).toBe(0);
    expect(visible.stdout).toBe("read ok\n");
    const settings = await runProbe(fx, ["read", join(fx.data, "settings.json")]);
    expect(settings.code, settings.stderr).toBe(0);
    expect(settings.stdout).toBe("read EACCES\n");
    const auth = await runProbe(fx, ["readdir", join(fx.data, "auth")]);
    expect(auth.stdout).toBe("readdir EACCES\n");
    const secrets = await runProbe(fx, ["read", join(fx.data, "n8n", "secrets.json")]);
    expect(secrets.stdout).toBe("read EACCES\n");
    expect(settings.stdout).not.toContain("secret");
  }, 60_000);

  it("A2 denies creating or overwriting a file in the data root", async () => {
    const fx = await makeFixture();
    const allowed = await runProbe(fx, ["write", join(fx.wt.path, "created.txt")]);
    expect(allowed.code, allowed.stderr).toBe(0);
    expect(allowed.stdout).toBe("write ok\n");
    expect(existsSync(join(fx.wt.path, "created.txt"))).toBe(true);
    const created = await runProbe(fx, ["write", join(fx.data, "pwned")]);
    expect(created.stdout).toBe("write EACCES\n");
    expect(existsSync(join(fx.data, "pwned"))).toBe(false);
    const overwritten = await runProbe(fx, ["overwrite", join(fx.data, "settings.json")]);
    expect(overwritten.stdout).toBe("overwrite EACCES\n");
    expect(await readFile(join(fx.data, "settings.json"), "utf8")).toBe('{"secret":true}\n');
  }, 60_000);

  it("A6 denies ~/.ssh, the real ~/.claude.json and a file in /tmp", async () => {
    const fx = await makeFixture();
    const home = homedir();
    const sshFile = join(home, ".ssh", "x");
    const sshDir = join(home, ".ssh");
    const claudeFile = join(home, ".claude.json");
    const tmpFile = join(tmpdir(), `boof-i1f-tmp-${process.pid}-${Date.now()}`);
    await writeFile(tmpFile, "tmp-secret\n");
    try {
      const ssh = await runProbe(fx, ["read", sshFile]);
      const sshTree = await runProbe(fx, ["readdir", sshDir]);
      const claude = await runProbe(fx, ["read", claudeFile]);
      const temp = await runProbe(fx, ["read", tmpFile]);
      expect(ssh.code, ssh.stderr).toBe(0);
      deniedOrAbsent(ssh.stdout, existsSync(sshFile), "read");
      deniedOrAbsent(sshTree.stdout, existsSync(sshDir), "readdir");
      deniedOrAbsent(claude.stdout, existsSync(claudeFile), "read");
      expect(temp.stdout).toBe("read EACCES\n");
      expect(ssh.stdout).not.toContain("BEGIN ");
      expect(claude.stdout).not.toContain("{");
      expect(temp.stdout).not.toContain("tmp-secret");
    } finally {
      await rm(tmpFile, { force: true });
    }
  }, 60_000);
});

function deniedOrAbsent(stdout: string, present: boolean, label: string): void {
  if (present) expect(stdout).toBe(`${label} EACCES\n`);
  else expect([`${label} EACCES\n`, `${label} ENOENT\n`]).toContain(stdout);
}
