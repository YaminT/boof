import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthStore,
  BOOF_VERSION,
  N8nSecretStore,
  PlanStore,
  ProjectStore,
  SettingsStore,
  TaskStore,
  WebhookSecretStore,
  backupDataRoot,
  defaultSettings,
  projectPaths,
  restoreDataRoot,
  scaffoldDataRoot,
  tryAcquireProcessLock,
} from "./index.js";
import { testGoal } from "./plan-fixtures.js";
import { newTask } from "./task-file.js";
import type { TaskFrontmatter } from "./schema.js";
import { readTarGz, writeRawTarGz, writeTarGz } from "./tar-gz.js";

const posix = process.platform !== "win32";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "boof-backup-")));
  dirs.push(dir);
  return dir;
}

const fm = (over: Partial<TaskFrontmatter> = {}): TaskFrontmatter => ({
  id: "t1",
  title: "T1",
  status: "pending",
  priority: 50,
  skip: false,
  labels: [],
  command: null,
  attachments: [],
  questions: "none",
  created: "2026-06-04T10:00:00.000Z",
  updated: "2026-06-04T10:00:00.000Z",
  ...over,
});

const fakeGit = async (dir: string) => {
  try {
    await readFile(join(dir, ".git", "HEAD"));
    return true;
  } catch {
    return false;
  }
};

async function writeSecret(path: string, body: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, body, { mode: 0o600 });
  if (posix) await chmod(path, 0o600);
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function archivePaths(archive: string): Promise<string[]> {
  const paths: string[] = [];
  await readTarGz(archive, async (member) => {
    paths.push(member.path);
  });
  return paths;
}

describe("tar.gz", () => {
  it("writes a ustar file and reads it back", async () => {
    const dir = await scratch();
    const src = join(dir, "src.txt");
    await writeFile(src, "hello");
    if (posix) await chmod(src, 0o640);
    const archive = join(dir, "a.tar.gz");
    await writeTarGz(archive, [{ path: "root/src.txt", kind: "file", mode: 0o640, source: src }]);
    const got: string[] = [];
    await readTarGz(archive, async (member) => {
      got.push(`${member.kind}:${member.path}:${member.mode}`);
      if (member.read) got.push((await member.read()).toString("utf8"));
    });
    expect(got).toEqual(["file:root/src.txt:416", "hello"]);
  });
});

describe("backup and restore", () => {
  it("round-trips projects, tasks, plans and clients, and keeps secret files private", async () => {
    const base = await scratch();
    const root = join(base, "data");
    const repo = join(base, "shop-repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    await scaffoldDataRoot(root);

    const projects = new ProjectStore(root, { isGitRepo: fakeGit });
    await projects.create({ workingDirectory: repo, id: "shop", name: "Shop" });
    const projectDir = projectPaths(root, "shop").dir;
    const tasks = new TaskStore(projectDir);
    await tasks.create(newTask(fm({ id: "one", title: "One", status: "pending" }), "do one"));
    await tasks.create(newTask(fm({ id: "two", title: "Two", status: "done" }), "do two"));
    await new PlanStore(projectDir).create({
      id: "build",
      title: "Build",
      source: { kind: "api" },
      goals: [testGoal("ship", 1)],
    });
    await new AuthStore(root).create({ name: "cli", scopes: ["projects:read"] });
    await new WebhookSecretStore(root).set("hook", "wh-secret");
    await new N8nSecretStore(root).setApiKey("n8n-key-value");
    await writeSecret(join(root, "owlish", "secrets.json"), '{"token":"owl"}\n');
    await writeSecret(join(root, "external-runs", `xr-${"ab".repeat(16)}.json`), "{}\n");
    await writeSecret(join(root, "projects", "shop", "secrets.json"), '{"k":1}\n');
    await writeSecret(join(root, "n8n", "workflows.json"), "{}\n");
    await writeSecret(join(root, "n8n", "seen.json"), "{}\n");
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "keep.txt"), "keep-me");
    await writeFile(join(root, "notes", "my file.txt"), "spaced");
    await writeFile(join(root, "notes", "my.lock"), "not-a-lock");
    const wide = join(root, "notes", "a".repeat(120), "b".repeat(120));
    await mkdir(wide, { recursive: true });
    await writeFile(join(wide, "wide.txt"), "wide");

    const settings = await new SettingsStore(root).load();
    await new SettingsStore(root).save({
      ...settings,
      worktree: { root: join(root, "custom-wt") },
    });
    await mkdir(join(root, "custom-wt"), { recursive: true });
    await writeFile(join(root, "custom-wt", "marker.txt"), "CUSTOM-WT");
    await mkdir(join(root, ".boof-runner-worktrees"), { recursive: true });
    await writeFile(join(root, ".boof-runner-worktrees", "marker.txt"), "NAMED-WT");
    const outside = join(base, "outside.txt");
    await writeFile(outside, "OUTSIDE-SECRET");
    if (posix) await symlink(outside, join(root, "link-out"));
    await writeFile(join(root, ".runner.pid"), "2000000000\n");
    await writeFile(join(root, "projects", ".create.lock"), "1\n");

    const archive = join(base, "root.tar.gz");
    let lockText = "";
    const result = await backupDataRoot(root, archive, {
      lock: { isProcessAlive: (pid) => pid === process.pid },
      onLocked: async () => {
        lockText = await readFile(join(root, ".migration.lock"), "utf8");
      },
    });
    expect(lockText.startsWith(String(process.pid))).toBe(true);
    expect(existsSync(join(root, ".migration.lock"))).toBe(false);
    if (posix) {
      expect(await modeOf(archive)).toBe(0o600);
      expect(result.skipped).toContain("symbolic link link-out");
    }

    const paths = await archivePaths(archive);
    expect(paths).toContain("manifest.json");
    expect(paths.some((p) => p.includes(".boof-runner-worktrees"))).toBe(false);
    expect(paths.some((p) => p.includes("custom-wt"))).toBe(false);
    expect(paths.some((p) => p.endsWith(".runner.pid"))).toBe(false);
    expect(paths.some((p) => p.includes(".migration.lock"))).toBe(false);
    expect(paths.some((p) => p.endsWith(".create.lock"))).toBe(false);
    expect(paths).toContain("root/notes/my.lock");
    expect(paths.some((p) => p.length > 255)).toBe(true);

    let manifest:
      | {
          boofVersion: string;
          schemaVersion: number | null;
          files: { path: string; sha256: string }[];
        }
      | undefined;
    await readTarGz(archive, async (member) => {
      if (member.path === "manifest.json" && member.read) {
        manifest = JSON.parse((await member.read()).toString("utf8"));
      }
    });
    expect(manifest?.boofVersion).toBe(BOOF_VERSION);
    expect(manifest?.schemaVersion).toBe(3);

    const dest = join(base, "restored");
    await restoreDataRoot(archive, dest);
    expect(await snapshot(root)).toEqual(await snapshot(dest));
    for (const file of manifest?.files ?? []) {
      expect(await sha256(join(dest, ...file.path.split("/")))).toBe(file.sha256);
      expect(await sha256(join(root, ...file.path.split("/")))).toBe(file.sha256);
    }
    expect(existsSync(join(dest, "custom-wt"))).toBe(false);
    expect(existsSync(join(dest, ".boof-runner-worktrees"))).toBe(false);
    expect(existsSync(join(dest, "link-out"))).toBe(false);
    expect(existsSync(join(dest, ".runner.pid"))).toBe(false);
    const restored = await readFile(join(dest, "notes", "keep.txt"), "utf8").catch(() => "");
    expect(restored).toBe("keep-me");
    const tree = JSON.stringify(await readdir(dest, { recursive: true }));
    expect(tree).not.toContain("OUTSIDE-SECRET");

    if (posix) {
      expect(await modeOf(dest)).toBe(0o700);
      expect(await modeOf(join(dest, "auth"))).toBe(0o700);
      for (const rel of [
        "auth/clients.json",
        "webhooks/secrets.json",
        "n8n/secrets.json",
        "n8n/workflows.json",
        "n8n/seen.json",
        "owlish/secrets.json",
        "projects/shop/secrets.json",
      ]) {
        expect(await modeOf(join(dest, rel)), rel).toBe(0o600);
      }
      const xr = (await readdir(join(dest, "external-runs")))[0]!;
      expect(await modeOf(join(dest, "external-runs", xr))).toBe(0o600);
    }
  });

  it("leaves secrets out of a --no-secrets archive and still restores the project", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await scaffoldDataRoot(root);
    await writeSecret(join(root, "auth", "clients.json"), '{"clients":[]}\n');
    await writeSecret(join(root, "webhooks", "secrets.json"), "{}\n");
    await writeSecret(join(root, "external-runs", "note.json"), "{}\n");
    await writeSecret(join(root, "n8n", "workflows.json"), '{"keep":true}\n');
    await writeFile(join(root, "notes.txt"), "visible");
    const archive = join(base, "nosec.tar.gz");
    await backupDataRoot(root, archive, { noSecrets: true });
    const paths = await archivePaths(archive);
    expect(paths.some((p) => p === "root/auth" || p.startsWith("root/auth/"))).toBe(false);
    expect(paths.some((p) => p.includes("external-runs"))).toBe(false);
    expect(paths.some((p) => p.endsWith("secrets.json"))).toBe(false);
    expect(paths).toContain("root/n8n/workflows.json");
    expect(paths).toContain("root/notes.txt");
    const dest = join(base, "restored");
    await restoreDataRoot(archive, dest);
    expect(await readFile(join(dest, "notes.txt"), "utf8")).toBe("visible");
    expect(await new AuthStore(dest).list()).toEqual([]);
    expect(existsSync(join(dest, "auth"))).toBe(false);
  });

  it("refuses a live runner or server unless --live, and does not create the archive", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await mkdir(root);
    await writeFile(join(root, "settings.json"), JSON.stringify(defaultSettings()) + "\n");
    const out = join(base, "out.tar.gz");
    const runner = await tryAcquireProcessLock(join(root, ".runner.pid"));
    expect(runner).not.toBeNull();
    try {
      await expect(backupDataRoot(root, out)).rejects.toThrow(/runner/);
      await expect(backupDataRoot(root, out)).rejects.toThrow(/--live/);
      expect(existsSync(out)).toBe(false);
      await backupDataRoot(root, out, { live: true });
      expect(existsSync(out)).toBe(true);
    } finally {
      await runner?.release();
    }

    const serverOut = join(base, "server.tar.gz");
    const server = await tryAcquireProcessLock(join(root, "webhooks", ".dispatcher.lock"));
    expect(server).not.toBeNull();
    try {
      await expect(backupDataRoot(root, serverOut)).rejects.toThrow(/server/);
      expect(existsSync(serverOut)).toBe(false);
    } finally {
      await server?.release();
    }
  });

  it("waits on a task lock only when --live", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await mkdir(join(root, "projects", "shop", "tasks", "pending"), { recursive: true });
    await mkdir(join(root, "projects", "shop", "tasks", ".locks"), { recursive: true });
    await writeFile(join(root, "settings.json"), JSON.stringify(defaultSettings()) + "\n");
    await writeFile(join(root, "projects", "shop", "tasks", "pending", "t1.md"), "task\n");
    await writeFile(join(root, "projects", "shop", "tasks", ".locks", "t1.lock"), "424242\n");
    const out = join(base, "out.tar.gz");
    const lock = {
      isProcessAlive: (pid: number) => pid === 424242,
      lockTimeoutMs: 200,
      lockPollMs: 20,
    };
    await expect(backupDataRoot(root, out, { live: true, lock })).rejects.toThrow(/t1/);
    expect(existsSync(out)).toBe(false);
    await backupDataRoot(root, join(base, "offline.tar.gz"), { lock });
    expect(existsSync(join(base, "offline.tar.gz"))).toBe(true);
  });

  it("refuses a tampered archive and leaves the destination untouched", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await mkdir(root);
    await writeFile(join(root, "settings.json"), JSON.stringify(defaultSettings()) + "\n");
    await writeFile(join(root, "hello.txt"), "ROUNDTRIP-MARKER");
    const archive = join(base, "ok.tar.gz");
    await backupDataRoot(root, archive);
    const raw = gunzipSync(await readFile(archive));
    const at = raw.indexOf("ROUNDTRIP-MARKER");
    expect(at).toBeGreaterThanOrEqual(0);
    raw[at] = raw[at]! ^ 0xff;
    const tampered = join(base, "bad.tar.gz");
    await writeFile(tampered, gzipSync(raw));
    const dest = join(base, "restored");
    await expect(restoreDataRoot(tampered, dest)).rejects.toThrow(
      /sha256 of hello.txt does not match/,
    );
    expect(existsSync(dest)).toBe(false);
    expect((await readdir(base)).some((name) => name.startsWith(".boof-restore-"))).toBe(false);
  });

  it("refuses a path that escapes the data root", async () => {
    const base = await scratch();
    const archive = join(base, "escape.tar.gz");
    const dest = join(base, "restored");
    await writeRawTarGz(archive, [{ path: "../evil", typeflag: "0", body: Buffer.from("pwned") }]);
    await expect(restoreDataRoot(archive, dest)).rejects.toThrow(/\.\.|escapes/);
    expect(existsSync(join(base, "evil"))).toBe(false);
    expect(existsSync(dest)).toBe(false);

    const long = join(base, "long.tar.gz");
    await writeRawTarGz(long, [
      { path: `../${"e".repeat(120)}`, typeflag: "0", body: Buffer.from("pwned") },
    ]);
    await expect(restoreDataRoot(long, dest)).rejects.toThrow(/\.\.|escapes/);
    expect(existsSync(dest)).toBe(false);
    const names = await readdir(base);
    expect(names.some((name) => name.includes("eee"))).toBe(false);
  });

  it("refuses a symlink entry", async () => {
    const base = await scratch();
    const archive = join(base, "link.tar.gz");
    const dest = join(base, "restored");
    await writeRawTarGz(archive, [{ path: "root/link", typeflag: "2", linkname: "outside" }]);
    await expect(restoreDataRoot(archive, dest)).rejects.toThrow(/symbolic link/i);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(join(base, "link"))).toBe(false);
  });

  it("refuses a destination that is not empty, and accepts an empty or missing one", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await mkdir(root);
    await writeFile(join(root, "settings.json"), JSON.stringify(defaultSettings()) + "\n");
    await writeFile(join(root, "hello.txt"), "ROUNDTRIP-MARKER");
    const archive = join(base, "ok.tar.gz");
    await backupDataRoot(root, archive);

    const occupied = join(base, "occupied");
    await mkdir(occupied);
    await writeFile(join(occupied, "keep.txt"), "stay");
    await expect(restoreDataRoot(archive, occupied)).rejects.toThrow(/not empty/);
    expect(await readFile(join(occupied, "keep.txt"), "utf8")).toBe("stay");
    expect(existsSync(join(occupied, "hello.txt"))).toBe(false);

    const empty = join(base, "empty");
    await mkdir(empty);
    await restoreDataRoot(archive, empty);
    expect(await readFile(join(empty, "hello.txt"), "utf8")).toBe("ROUNDTRIP-MARKER");

    const missing = join(base, "missing");
    await restoreDataRoot(archive, missing);
    expect(await readFile(join(missing, "hello.txt"), "utf8")).toBe("ROUNDTRIP-MARKER");
  });

  it("refuses a newer schema and migrates an older one", async () => {
    const base = await scratch();
    const newerRoot = join(base, "newer");
    await mkdir(newerRoot);
    await writeFile(join(newerRoot, "settings.json"), JSON.stringify({ schemaVersion: 4 }) + "\n");
    const newerArchive = join(base, "newer.tar.gz");
    const backed = await backupDataRoot(newerRoot, newerArchive);
    expect(backed.schemaVersion).toBe(4);
    const newerDest = join(base, "newer-dest");
    await expect(restoreDataRoot(newerArchive, newerDest)).rejects.toThrow(/newer/);
    expect(existsSync(newerDest)).toBe(false);

    const olderRoot = join(base, "older");
    await mkdir(olderRoot);
    await writeFile(
      join(olderRoot, "settings.json"),
      JSON.stringify({ ...defaultSettings(), schemaVersion: 2, defaultProject: "shop" }, null, 2) +
        "\n",
    );
    const olderArchive = join(base, "older.tar.gz");
    await backupDataRoot(olderRoot, olderArchive);
    const olderDest = join(base, "older-dest");
    await restoreDataRoot(olderArchive, olderDest);
    expect((await new SettingsStore(olderDest).load()).schemaVersion).toBe(3);
  });

  it("refuses to overwrite an archive or to write inside the data root", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await mkdir(root);
    await writeFile(join(root, "settings.json"), JSON.stringify(defaultSettings()) + "\n");
    const out = join(base, "out.tar.gz");
    await writeFile(out, "keep");
    await expect(backupDataRoot(root, out)).rejects.toThrow(/overwrite/);
    expect(await readFile(out, "utf8")).toBe("keep");
    await expect(backupDataRoot(root, join(root, "in.tar.gz"))).rejects.toThrow(
      /inside the data root/,
    );
    expect(existsSync(join(root, "in.tar.gz"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("refuses to restore into a symbolic link", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await mkdir(root);
    await writeFile(join(root, "settings.json"), JSON.stringify(defaultSettings()) + "\n");
    const archive = join(base, "ok.tar.gz");
    await backupDataRoot(root, archive);
    const real = join(base, "real");
    await mkdir(real);
    const dest = join(base, "link");
    await symlink(real, dest);
    await expect(restoreDataRoot(archive, dest)).rejects.toThrow(/symbolic link/);
    expect((await lstat(dest)).isSymbolicLink()).toBe(true);
    expect(await readdir(real)).toEqual([]);
  });
});

async function snapshot(root: string): Promise<unknown> {
  const projects = await new ProjectStore(root).list({ includeArchived: true });
  const tasks = [];
  const plans = [];
  for (const project of projects) {
    const dir = projectPaths(root, project.id).dir;
    tasks.push(...(await new TaskStore(dir).list()));
    plans.push(...(await new PlanStore(dir).list()));
  }
  const clients = await new AuthStore(root).list();
  const by = <T extends { id: string }>(xs: T[]) =>
    [...xs].sort((a, b) => a.id.localeCompare(b.id));
  return {
    projects: by(projects),
    tasks: [...tasks].sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id)),
    plans: by(plans),
    clients: by(clients),
  };
}
