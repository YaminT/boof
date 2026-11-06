import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execCommand, SecuritySettingsSchema, SettingsStore, scaffoldDataRoot } from "@boof/heart";
import { mockState, resetMock } from "@boof/runner";
import { runCommand, scanCommand } from "./boof-runner.js";

const SECRET = "sk-ant-api03-SECRETKEY";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "boof-run-audit-"));
  roots.push(root);
  return root;
}

async function auditLines(root: string): Promise<Record<string, unknown>[]> {
  const dir = join(root, "audit");
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl"));
  const text = (await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")))).join("");
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function findNamed(dir: string, name: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) findNamed(path, name, out);
    else if (ent.name === name) out.push(path);
  }
  return out;
}

function assertLine(
  line: Record<string, unknown>,
  expected: { action: string; outcome: "ok" | "error"; project?: string; error?: string },
) {
  const keys = ["action", "kind", "ms", "outcome", "principal", "ts", "via"];
  if (expected.error) keys.push("error");
  if (expected.project) keys.push("project");
  expect(Object.keys(line).sort()).toEqual(keys.sort());
  expect(line).toMatchObject({
    principal: "local",
    kind: "local",
    via: "cli",
    action: expected.action,
    outcome: expected.outcome,
    ...(expected.project ? { project: expected.project } : {}),
    ...(expected.error ? { error: expected.error } : {}),
  });
  expect(JSON.stringify(line)).not.toMatch(/sk-ant-api03/i);
}

async function disableAudit(root: string): Promise<void> {
  await scaffoldDataRoot(root);
  const store = new SettingsStore(root);
  const settings = await store.load();
  await store.save({
    ...settings,
    security: SecuritySettingsSchema.parse({
      ...settings.security,
      audit: { enabled: false, retentionDays: 90 },
    }),
  });
}

async function gitRepo(parent: string, name: string, commit = false): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  const git = (args: string[]) => execCommand("git", args, { cwd: dir, timeoutMs: 15000 });
  await git(["init", "-q", "-b", "main"]);
  if (commit) {
    await git(["config", "user.email", "t@e.com"]);
    await git(["config", "user.name", "T"]);
    await writeFile(join(dir, "README.md"), "# work\n");
    await git(["add", "."]);
    await git(["commit", "-m", "init"]);
  }
  return realpath(dir);
}

const goalXml = `<?xml version="1.0" encoding="UTF-8"?>
<boof>
  <overal><goal>Core</goal><stack>TypeScript</stack><rules><do>Test.</do></rules></overal>
  <progress>
    <status><versions><version number="1" status="plan">seed</version></versions></status>
    <tests><strategy>TDD</strategy><technology>vitest</technology><run>npm test</run></tests>
  </progress>
</boof>`;

describe("run and scan audit", () => {
  it("run writes one line for a finished task and one for a missing project", async () => {
    const root = await scratch();
    const parent = await scratch();
    const repo = await gitRepo(parent, "shop", true);
    let text = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      text += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    let code = 1;
    try {
      code = await runCommand([
        "--data",
        root,
        "--repo",
        repo,
        "--tool",
        "mock",
        "--model",
        SECRET,
        `Build ${SECRET}`,
      ]);
    } finally {
      process.stdout.write = write;
    }
    expect(code).toBe(0);
    expect(text).toContain("[done]");
    expect(text).toContain("shop/");
    const ok = await auditLines(root);
    expect(ok).toHaveLength(1);
    assertLine(ok[0]!, { action: "cli:run", outcome: "ok", project: "shop" });

    await expect(
      runCommand(["--data", root, "--project", "missing", "--tool", "mock", `Build ${SECRET}`]),
    ).rejects.toThrow(/Project not found/);
    const lines = await auditLines(root);
    expect(lines).toHaveLength(2);
    assertLine(lines[1]!, {
      action: "cli:run",
      outcome: "error",
      error: "project_resolution",
    });
    expect(JSON.stringify(lines[1])).not.toContain("missing");

    expect(await runCommand(["--data", root])).toBe(1);
    expect(await auditLines(root)).toHaveLength(2);

    const runSecret = "sk-ant-api03-RUNSECRET";
    await expect(
      runCommand(["--data", root, "--project", runSecret, "--tool", "mock", "Build it"]),
    ).rejects.toThrow(/Invalid id/);
    expect(JSON.stringify(await auditLines(root))).not.toMatch(/sk-ant-api03/i);
    assertLine((await auditLines(root)).at(-1)!, {
      action: "cli:run",
      outcome: "error",
      error: "invalid_id",
    });

    const hex = "0123456789abcdef0123456789abcdef";
    await expect(
      runCommand(["--data", root, "--project", hex, "--tool", "mock", "Build it"]),
    ).rejects.toThrow(/Project not found/);
    expect(JSON.stringify(await auditLines(root))).not.toContain(hex);

    await disableAudit(root);
    await expect(
      runCommand(["--data", root, "--project", "missing", `Build ${SECRET}`]),
    ).rejects.toThrow(/Project not found/);
    expect(await auditLines(root)).toHaveLength(4);
  }, 60_000);

  it("SIGINT during the first agent call dies by signal and leaves the task running", async () => {
    const root = await scratch();
    const parent = await scratch();
    const home = await scratch();
    const repo = await gitRepo(parent, "shop", true);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    for (const key of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "BOOF_RUNNER_DATA_ROOT",
    ]) {
      delete env[key];
    }
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        "bin/src/boof-runner.ts",
        "run",
        "--data",
        root,
        "--repo",
        repo,
        "--tool",
        "mock",
        "[[mock-stall planner=1]] Build it",
      ],
      { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    let pgid: number | undefined;
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    let pidFile: string;
    try {
      pidFile = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`agent did not start; output:\n${output}`));
        }, 25_000);
        const poll = setInterval(() => {
          const found = findNamed(join(root, "projects"), "pid");
          if (found[0]) {
            clearInterval(poll);
            clearTimeout(timer);
            resolve(found[0]);
          }
        }, 30);
      });
      pgid = (JSON.parse(readFileSync(pidFile, "utf8")) as { pgid: number }).pgid;
      child.kill("SIGINT");
      const exit = await Promise.race([
        exitPromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`run did not die; output:\n${output}`));
          }, 10_000);
        }),
      ]);
      let groupAlive = true;
      try {
        process.kill(pgid, 0);
      } catch {
        groupAlive = false;
      }
      expect(exit, output).toEqual({ code: null, signal: "SIGINT" });
      expect(groupAlive, "agent group survives parent death, as a default SIGINT left it").toBe(
        true,
      );
      const area = dirname(dirname(pidFile));
      const log = await readFile(join(area, "log.txt"), "utf8");
      expect(log).toContain("### Planner");
      expect(log).not.toContain("### Developer");
      expect(area).toContain(join("tasks", "ongoing"));
      const task = await readFile(join(area, "task.md"), "utf8");
      expect(task).toMatch(/^status: running$/m);
      const lines = await auditLines(root);
      expect(lines).toHaveLength(1);
      assertLine(lines[0]!, {
        action: "cli:run",
        outcome: "error",
        project: "shop",
        error: "interrupted",
      });
    } finally {
      if (pgid !== undefined) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 45_000);

  it("an abort signal after the task is created still writes a line", async () => {
    const root = await scratch();
    const parent = await scratch();
    const repo = await gitRepo(parent, "shop", true);
    const controller = new AbortController();
    mockState.onRun = async () => {
      controller.abort();
    };
    let text = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      text += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    let code = 0;
    try {
      code = await runCommand(
        ["--data", root, "--repo", repo, "--tool", "mock", "Build it"],
        controller.signal,
      );
    } finally {
      process.stdout.write = write;
      resetMock();
    }
    expect(code).toBe(130);
    expect(text).toContain("shop/");
    const lines = await auditLines(root);
    expect(lines).toHaveLength(1);
    assertLine(lines[0]!, {
      action: "cli:run",
      outcome: "error",
      project: "shop",
      error: "interrupted",
    });
  }, 60_000);

  it("scan writes one line when it creates tasks, and none for a dry run or an empty repo", async () => {
    const root = await scratch();
    const parent = await scratch();
    const repo = await gitRepo(parent, "shop");
    await mkdir(join(repo, "core"));
    await writeFile(join(repo, "core", "goal.boof.xml"), goalXml);
    const other = await gitRepo(parent, "other");
    await mkdir(join(other, "core"));
    await writeFile(join(other, "core", "goal.boof.xml"), goalXml);

    let text = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      text += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await scanCommand(["--data", root, "--dry-run", "--model", SECRET, repo])).toBe(0);
      expect(await auditLines(root)).toHaveLength(0);

      const empty = await gitRepo(parent, "empty");
      expect(await scanCommand(["--data", root, "--project", "shop", empty])).toBe(0);
      expect(await auditLines(root)).toHaveLength(0);

      expect(await scanCommand(["--data", root, "--tool", "mock", "--model", SECRET, repo])).toBe(
        0,
      );
    } finally {
      process.stdout.write = write;
    }
    expect(text).toContain("Created");
    const ok = await auditLines(root);
    expect(ok).toHaveLength(1);
    assertLine(ok[0]!, { action: "cli:scan", outcome: "ok", project: "shop" });

    text = "";
    await expect(
      scanCommand(["--data", root, "--project", "shop", "--model", SECRET, other]),
    ).rejects.toThrow(/not /);
    const lines = await auditLines(root);
    expect(lines).toHaveLength(2);
    assertLine(lines[1]!, {
      action: "cli:scan",
      outcome: "error",
      project: "shop",
      error: "project_resolution",
    });

    expect(await scanCommand(["--data", root])).toBe(1);
    expect(await auditLines(root)).toHaveLength(2);

    const scanSecret = "sk-ant-api03-SCANSECRET";
    await expect(scanCommand(["--data", root, "--project", scanSecret, repo])).rejects.toThrow(
      /Invalid id/,
    );
    expect(JSON.stringify(await auditLines(root))).not.toMatch(/sk-ant-api03/i);
    assertLine((await auditLines(root)).at(-1)!, {
      action: "cli:scan",
      outcome: "error",
      error: "invalid_id",
    });

    await disableAudit(root);
    await expect(
      scanCommand(["--data", root, "--project", "shop", "--model", SECRET, other]),
    ).rejects.toThrow(/not /);
    expect(await auditLines(root)).toHaveLength(3);
  });
});
