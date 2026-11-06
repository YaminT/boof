import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execCommand, SecuritySettingsSchema, SettingsStore, scaffoldDataRoot } from "@boof/heart";
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
      project: "missing",
      error: "project_resolution",
    });

    expect(await runCommand(["--data", root])).toBe(1);
    expect(await auditLines(root)).toHaveLength(2);

    await disableAudit(root);
    await expect(
      runCommand(["--data", root, "--project", "missing", `Build ${SECRET}`]),
    ).rejects.toThrow(/Project not found/);
    expect(await auditLines(root)).toHaveLength(2);
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

    await disableAudit(root);
    await expect(
      scanCommand(["--data", root, "--project", "shop", "--model", SECRET, other]),
    ).rejects.toThrow(/not /);
    expect(await auditLines(root)).toHaveLength(2);
  });
});
