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
  utimes,
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
  backupDataRoot as backupDataRootImpl,
  type BackupOptions,
  defaultSettings,
  dataRootPaths,
  projectPaths,
  restoreDataRoot as restoreDataRootImpl,
  type RestoreOptions,
  scaffoldDataRoot,
  tryAcquireProcessLock,
} from "./index.js";
import { safeAttachmentName } from "./attachments.js";
import { installSignalCleanup } from "./signal-cleanup.js";
import { EventEmitter } from "node:events";
import { testGoal } from "./plan-fixtures.js";
import { newTask } from "./task-file.js";
import type { TaskFrontmatter } from "./schema.js";
import { readTarGz, writeRawTarGz, writeTarGz } from "./tar-gz.js";
import type { WindowsAclOps } from "./windows-acl.js";
import { tightenWindowsPath } from "./data-root-mode.js";

const posix = process.platform !== "win32";
const dirs: string[] = [];
const fakeWindowsAcl: WindowsAclOps = (() => {
  const secured = new Set<string>();
  const sid = "S-1-5-21-1000";
  return {
    async currentUser() {
      return { account: "test-user", sid };
    },
    async readAcl(path) {
      const user = { sid, allow: true, inherited: false, inheritOnly: false, rights: "FA" };
      return {
        ok: true as const,
        aces: secured.has(path)
          ? [user]
          : [
              user,
              { sid: "S-1-1-0", allow: true, inherited: true, inheritOnly: false, rights: "FA" },
            ],
      };
    },
    async tightenToUser(path) {
      secured.add(path);
      return true;
    },
  };
})();

async function backupDataRoot(root: string, out: string, opts: BackupOptions = {}) {
  return backupDataRootImpl(root, out, {
    ...opts,
    ...(process.platform === "win32" ? { windowsAcl: opts.windowsAcl ?? fakeWindowsAcl } : {}),
  });
}

async function restoreDataRoot(archive: string, dest: string, opts: RestoreOptions = {}) {
  return restoreDataRootImpl(archive, dest, {
    ...opts,
    ...(process.platform === "win32" ? { windowsAcl: opts.windowsAcl ?? fakeWindowsAcl } : {}),
  });
}

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

function setTarSize(raw: Buffer, headerAt: number, size: number): void {
  const header = raw.subarray(headerAt, headerAt + 512);
  header.fill(0, 124, 136);
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0"), 148, "ascii");
  header[154] = 0;
  header[155] = 0x20;
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

describe("backup Windows ACL protection", () => {
  it("uses the data-root owner-only ACL operation for archive and temp paths", async () => {
    const secured: string[] = [];
    const sid = "S-1-5-21-1000";
    const acl: WindowsAclOps = {
      async currentUser() {
        return { account: "test-user", sid };
      },
      async readAcl(path) {
        const user = { sid, allow: true, inherited: false, inheritOnly: false, rights: "FA" };
        return {
          ok: true,
          aces: secured.includes(path)
            ? [user]
            : [
                user,
                { sid: "S-1-1-0", allow: true, inherited: true, inheritOnly: false, rights: "FA" },
              ],
        };
      },
      async tightenToUser(path) {
        secured.push(path);
        return true;
      },
    };
    await tightenWindowsPath("C:\\Temp\\boof-backup-stage", { platform: "win32", windowsAcl: acl });
    await tightenWindowsPath("C:\\Temp\\archive.tar.gz", { platform: "win32", windowsAcl: acl });
    expect(secured).toEqual(["C:\\Temp\\boof-backup-stage", "C:\\Temp\\archive.tar.gz"]);
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
    await writeSecret(join(root, "owlish", "project-keys.json"), '{"shop":"sk-secret"}\n');
    await writeSecret(
      join(root, "claude-agent-config", "shop", ".credentials.json"),
      '{"token":"secret"}\n',
    );
    await writeSecret(join(root, "concierge", "shop", "transcript.jsonl"), "secret transcript\n");
    await writeSecret(join(root, "idempotency", "cached.json"), '{"body":"private"}\n');
    await writeFile(join(root, "notes.txt"), "visible");
    const archive = join(base, "nosec.tar.gz");
    await backupDataRoot(root, archive, { noSecrets: true });
    const paths = await archivePaths(archive);
    expect(paths.some((p) => p === "root/auth" || p.startsWith("root/auth/"))).toBe(false);
    expect(paths.some((p) => p.includes("external-runs"))).toBe(false);
    expect(paths.some((p) => p.endsWith("secrets.json"))).toBe(false);
    expect(paths.some((p) => p === "root/n8n" || p.startsWith("root/n8n/"))).toBe(false);
    for (const secretPath of [
      "owlish/project-keys.json",
      "claude-agent-config/shop/.credentials.json",
      "concierge/shop/transcript.jsonl",
      "idempotency/cached.json",
    ]) {
      expect(paths).not.toContain(`root/${secretPath}`);
    }
    expect(paths).toContain("root/notes.txt");
    const dest = join(base, "restored");
    await restoreDataRoot(archive, dest);
    expect(await readFile(join(dest, "notes.txt"), "utf8")).toBe("visible");
    expect(await new AuthStore(dest).list()).toEqual([]);
    expect(existsSync(join(dest, "auth"))).toBe(false);
  });

  it("classifies every private data-root layout path as secret or explicitly safe", async () => {
    const { classifyDataRootPath } = await import("./backup.js");
    const layout = dataRootPaths("/data");
    const layoutPaths = [
      layout.auth,
      layout.authClients,
      layout.browserSessions,
      layout.browserLinks,
      layout.webhooks,
      layout.webhookSecrets,
      layout.owlishSecrets,
      layout.owlishProjectKeys,
      layout.claudeAgentConfigs + "/shop/.credentials.json",
      layout.n8n,
      layout.n8nSecrets,
      layout.n8nWorkflows,
      layout.n8nSeen,
      layout.externalRuns,
      layout.idempotency,
      "/data/concierge/shop/transcript.jsonl",
      layout.audit,
    ];
    expect(
      layoutPaths.every(
        (path) => classifyDataRootPath(path.replace(/^[/\\]data[/\\]/i, "")) !== "unclassified",
      ),
    ).toBe(true);
    const paths = [
      "auth/clients.json",
      "auth/browser-sessions.json",
      "auth/browser-links.json",
      "owlish/secrets.json",
      "owlish/project-keys.json",
      "claude-agent-config/shop/.credentials.json",
      "external-runs/run.json",
      "concierge/shop/transcript.jsonl",
      "idempotency/cached.json",
      "n8n/secrets.json",
      "n8n/workflows.json",
      "webhooks/secrets.json",
      "webhooks/config.json",
      "audit/events.jsonl",
    ];
    expect(paths.every((path) => classifyDataRootPath(path) !== "unclassified")).toBe(true);
    for (const path of paths.filter(
      (path) => !path.startsWith("audit/") && path !== "webhooks/config.json",
    )) {
      expect(classifyDataRootPath(path), path).toBe("secret");
    }
  });

  it("restores every file privately without executable bits, including case-folded secret names", async () => {
    const base = await scratch();
    const archive = join(base, "modes.tar.gz");
    const content = Buffer.from(JSON.stringify(defaultSettings()) + "\n");
    const clients = Buffer.from('{"clients":[]}\n');
    const manifest = Buffer.from(
      JSON.stringify({
        format: 1,
        boofVersion: BOOF_VERSION,
        schemaVersion: defaultSettings().schemaVersion,
        files: [
          ["Auth/clients.json", clients],
          ["settings.json", content],
        ].map(([path, body]) => ({
          path,
          sha256: createHash("sha256")
            .update(body as Buffer)
            .digest("hex"),
          mode: 0o777,
        })),
      }),
    );
    await writeTarGz(archive, [
      { path: "manifest.json", kind: "file", mode: 0o600, body: manifest },
      { path: "root", kind: "dir", mode: 0o700 },
      { path: "root/Auth", kind: "dir", mode: 0o777 },
      { path: "root/Auth/clients.json", kind: "file", mode: 0o777, body: clients },
      { path: "root/settings.json", kind: "file", mode: 0o777, body: content },
    ]);
    const dest = join(base, "restored");
    await restoreDataRoot(archive, dest);
    if (posix) {
      expect(await modeOf(join(dest, "settings.json"))).toBe(0o600);
      expect(await modeOf(join(dest, "Auth", "clients.json"))).toBe(0o600);
      expect(await modeOf(join(dest, "Auth"))).toBe(0o700);
    }
  });

  it("rejects Windows-invalid archive names on every platform", async () => {
    const base = await scratch();
    for (const name of [
      "root/a:stream",
      "root/NUL.txt",
      "root/NUL .txt",
      "root/aux.json",
      "root/CONIN$",
      "root/trailing.",
      "root/trailing ",
    ]) {
      const archive = join(base, `${Buffer.from(name).toString("hex")}.tar.gz`);
      await writeRawTarGz(archive, [{ path: name, typeflag: "0", body: Buffer.from("x") }]);
      await expect(restoreDataRoot(archive, join(base, "dest"))).rejects.toThrow(
        /unsafe|Windows|name|escapes/i,
      );
    }
  });

  it("rejects an oversized tar header before allocating its body", async () => {
    const base = await scratch();
    const archive = join(base, "oversized.tar.gz");
    await writeRawTarGz(archive, [{ path: "root/huge", typeflag: "0", body: Buffer.from("x") }]);
    const raw = gunzipSync(await readFile(archive));
    setTarSize(raw, 0, 1024 * 1024 * 1024 + 1);
    await writeFile(archive, gzipSync(raw));
    await expect(restoreDataRoot(archive, join(base, "dest"))).rejects.toThrow(/larger than 1 GiB/);
  });

  it("rejects an oversized pax header before buffering its body", async () => {
    const base = await scratch();
    const archive = join(base, "oversized-pax.tar.gz");
    await writeRawTarGz(archive, [
      { path: `root/${"p".repeat(300)}`, typeflag: "0", body: Buffer.from("x") },
    ]);
    const raw = gunzipSync(await readFile(archive));
    const oldSize = Number.parseInt(raw.toString("ascii", 124, 136).replace(/\0.*$/, "").trim(), 8);
    const restAt = 512 + Math.ceil(oldSize / 512) * 512;
    const header = Buffer.from(raw.subarray(0, 512));
    setTarSize(header, 0, 65 * 1024);
    const paxSize = 65 * 1024;
    const paxPadding = (512 - (paxSize % 512)) % 512;
    await writeFile(
      archive,
      gzipSync(
        Buffer.concat([
          header,
          Buffer.alloc(paxSize),
          Buffer.alloc(paxPadding),
          raw.subarray(restAt),
        ]),
      ),
    );
    await expect(restoreDataRoot(archive, join(base, "dest"))).rejects.toThrow(
      /pax header is larger than 64 KiB/,
    );
  });

  it.skipIf(process.platform === "win32")(
    "skips hard-linked files so an outside secret cannot enter a backup",
    async () => {
      const base = await scratch();
      const root = join(base, "data");
      await mkdir(root);
      await writeFile(join(root, "settings.json"), JSON.stringify(defaultSettings()) + "\n");
      const outside = join(base, "outside-secret");
      await writeFile(outside, "private-key");
      await (await import("node:fs/promises")).link(outside, join(root, "planted"));
      const archive = join(base, "backup.tar.gz");
      const result = await backupDataRoot(root, archive);
      expect(result.skipped).toContain("hard-linked file planted");
      expect(await archivePaths(archive)).not.toContain("root/planted");
    },
  );

  it("removes stale interrupted backup and restore directories on the next run", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await mkdir(root);
    await writeFile(join(root, "settings.json"), JSON.stringify(defaultSettings()) + "\n");
    const staleBackup = join(tmpdir(), `boof-backup-i10-${process.pid}-${Date.now()}`);
    await mkdir(staleBackup);
    await writeFile(join(staleBackup, "partial"), "secret");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(staleBackup, old, old);
    const archive = join(base, "backup.tar.gz");
    await backupDataRoot(root, archive);
    expect(existsSync(staleBackup)).toBe(false);

    const staleRestore = join(base, `.boof-restore-i10-${Date.now()}`);
    await mkdir(staleRestore);
    await writeFile(join(staleRestore, "partial"), "secret");
    await utimes(staleRestore, old, old);
    await restoreDataRoot(archive, join(base, "restored"));
    expect(existsSync(staleRestore)).toBe(false);
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

async function rawBackup(
  archive: string,
  files: Record<string, string | Buffer>,
  schemaVersion: number | null = null,
): Promise<void> {
  const bodies = Object.entries(files).map(([path, body]) => ({
    path,
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
  }));
  const manifest = {
    format: 1,
    boofVersion: BOOF_VERSION,
    schemaVersion,
    files: bodies.map((f) => ({
      path: f.path,
      sha256: createHash("sha256").update(f.body).digest("hex"),
      mode: 0o600,
    })),
  };
  const dirs = new Set<string>();
  for (const f of bodies) {
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
  }
  await writeRawTarGz(archive, [
    { path: "manifest.json", typeflag: "0", body: Buffer.from(JSON.stringify(manifest)) },
    { path: "root", typeflag: "5" },
    ...[...dirs].sort().map((d) => ({ path: `root/${d}`, typeflag: "5" as const })),
    ...bodies.map((f) => ({ path: `root/${f.path}`, typeflag: "0" as const, body: f.body })),
  ]);
}

function recordingAcl(onTighten: (path: string) => void | Promise<void>): WindowsAclOps {
  const secured = new Set<string>();
  const sid = "S-1-5-21-1000";
  return {
    async currentUser() {
      return { account: "test-user", sid };
    },
    async readAcl(path) {
      const user = { sid, allow: true, inherited: false, inheritOnly: false, rights: "FA" };
      const everyone = {
        sid: "S-1-1-0",
        allow: true,
        inherited: true,
        inheritOnly: false,
        rights: "FA",
      };
      return { ok: true as const, aces: secured.has(path) ? [user] : [user, everyone] };
    },
    async tightenToUser(path) {
      await onTighten(path);
      secured.add(path);
      return true;
    },
  };
}

describe("backup and restore hardening", () => {
  it("validates auth/clients.json before publishing and leaves nothing behind", async () => {
    const base = await scratch();
    const archive = join(base, "bad.tar.gz");
    await rawBackup(archive, { "auth/clients.json": '{"clients":[{"id":"x"}]}' });
    const dest = join(base, "dest");
    await expect(restoreDataRoot(archive, dest)).rejects.toThrow(/auth\/clients\.json/);
    expect(existsSync(dest)).toBe(false);
    expect((await readdir(base)).filter((n) => n.startsWith(".boof-restore-"))).toEqual([]);
    await mkdir(dest);
    await expect(restoreDataRoot(archive, dest)).rejects.toThrow(/auth\/clients\.json/);
    expect(await readdir(dest)).toEqual([]);
  });

  it("refuses a backup over the restore limit and writes no archive", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await scaffoldDataRoot(root);
    await writeFile(join(root, "big.bin"), Buffer.alloc(2 * 1024 * 1024));
    const archive = join(base, "big.tar.gz");
    await expect(backupDataRoot(root, archive, { maxBytes: 1024 * 1024 })).rejects.toThrow(
      /larger than/,
    );
    expect(existsSync(archive)).toBe(false);
  });

  it("a backup under the limit restores under the same limit", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await scaffoldDataRoot(root);
    await writeFile(join(root, "mid.bin"), Buffer.alloc(900 * 1024, 7));
    const archive = join(base, "mid.tar.gz");
    const limit = 1024 * 1024;
    await backupDataRoot(root, archive, { maxBytes: limit });
    await restoreDataRoot(archive, join(base, "dest"), { maxBytes: limit });
    expect((await stat(join(base, "dest", "mid.bin"))).size).toBe(900 * 1024);
  });

  it.skipIf(!posix)("skips names Windows cannot store and still backs up the rest", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await scaffoldDataRoot(root);
    const assets = join(root, "tasks", "assets", "t1");
    await mkdir(assets, { recursive: true });
    for (const name of ["aux.png", "report.", "notes:1.md", "what?.md", "fine.png"]) {
      await writeFile(join(assets, name), "x");
    }
    const archive = join(base, "names.tar.gz");
    const result = await backupDataRoot(root, archive);
    const joined = result.skipped.join("\n");
    for (const name of ["aux.png", "report.", "notes:1.md", "what?.md"]) {
      expect(joined).toContain(`tasks/assets/t1/${name}`);
    }
    const paths = await archivePaths(archive);
    expect(paths).toContain("root/tasks/assets/t1/fine.png");
    expect(paths.some((p) => p.includes("aux.png"))).toBe(false);
    await restoreDataRoot(archive, join(base, "dest"));
    expect(await readFile(join(base, "dest", "tasks", "assets", "t1", "fine.png"), "utf8")).toBe(
      "x",
    );
  });

  it("makes attachment names portable", () => {
    expect(safeAttachmentName("aux.png")).toBe("_aux.png");
    expect(safeAttachmentName("con.txt")).toBe("_con.txt");
    expect(safeAttachmentName("report.")).toBe("report");
    expect(safeAttachmentName("shot.png")).toBe("shot.png");
  });

  it("applies the Windows ACL to the archive while it is still empty", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await scaffoldDataRoot(root);
    const archive = join(base, "acl.tar.gz");
    let sizeAtAcl = -1;
    const acl = recordingAcl(async (path) => {
      if (path === archive) sizeAtAcl = (await stat(path)).size;
    });
    await backupDataRootImpl(root, archive, { platform: "win32", windowsAcl: acl });
    expect(sizeAtAcl).toBe(0);
    expect((await stat(archive)).size).toBeGreaterThan(0);
  });

  it("removes the archive when protecting it fails", async () => {
    const base = await scratch();
    const root = join(base, "data");
    await scaffoldDataRoot(root);
    const archive = join(base, "fail.tar.gz");
    const acl = recordingAcl((path) => {
      if (path === archive) throw new Error("acl failed");
    });
    await expect(
      backupDataRootImpl(root, archive, { platform: "win32", windowsAcl: acl }),
    ).rejects.toThrow(/acl failed/);
    expect(existsSync(archive)).toBe(false);
  });

  it("applies the Windows ACL to the restore temp folder before anything is extracted", async () => {
    const base = await scratch();
    const archive = join(base, "a.tar.gz");
    await rawBackup(archive, { "notes.txt": "hi" });
    const dest = join(base, "dest");
    const seen: { path: string; entries: string[] }[] = [];
    const acl = recordingAcl(async (path) => {
      seen.push({ path, entries: await readdir(path).catch(() => ["?"]) });
    });
    await restoreDataRootImpl(archive, dest, { platform: "win32", windowsAcl: acl });
    expect(seen[0]!.path.startsWith(join(base, ".boof-restore-"))).toBe(true);
    expect(seen[0]!.entries).toEqual([]);
  });

  it("bounds a small, highly compressible archive by free space and the hard cap", async () => {
    const base = await scratch();
    const archive = join(base, "zeros.tar.gz");
    await rawBackup(archive, { "zeros.bin": Buffer.alloc(8 * 1024 * 1024) });
    expect((await stat(archive)).size).toBeLessThan(64 * 1024);
    await expect(
      restoreDataRoot(archive, join(base, "d1"), { freeBytes: async () => 10 * 1024 * 1024 }),
    ).rejects.toThrow(/free disk space/);
    await expect(
      restoreDataRoot(archive, join(base, "d2"), { maxBytes: 4 * 1024 * 1024 }),
    ).rejects.toThrow(/limit|larger than/);
    expect(existsSync(join(base, "d1"))).toBe(false);
    expect(existsSync(join(base, "d2"))).toBe(false);
    expect((await readdir(base)).filter((n) => n.startsWith(".boof-restore-"))).toEqual([]);
    await restoreDataRoot(archive, join(base, "d3"));
    expect((await stat(join(base, "d3", "zeros.bin"))).size).toBe(8 * 1024 * 1024);
  });

  it("removes paths synchronously on a signal and marks the run interrupted", async () => {
    const base = await scratch();
    const a = join(base, "a");
    const b = join(base, "b.tar.gz");
    await mkdir(a);
    await writeFile(join(a, "f"), "x");
    await writeFile(b, "partial");
    const target = new EventEmitter() as unknown as NodeJS.Process;
    const killed: string[] = [];
    const cleanup = installSignalCleanup([a], { target, kill: (s) => void killed.push(s) });
    cleanup.add(b);
    expect(cleanup.interrupted()).toBe(false);
    target.emit("SIGINT");
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(killed).toEqual(["SIGINT"]);
    expect(cleanup.interrupted()).toBe(true);
    expect(target.listenerCount("SIGINT")).toBe(0);
    expect(target.listenerCount("SIGTERM")).toBe(0);
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
