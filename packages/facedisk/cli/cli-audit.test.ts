import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTaskInHierarchy,
  execCommand,
  newTask,
  ProjectStore,
  SecuritySettingsSchema,
  SettingsStore,
  scaffoldDataRoot,
} from "@boof/heart";
import { authCommand } from "./auth-cli.js";
import { epicCommand } from "./epic-cli.js";
import { planCommand } from "./plan-cli.js";
import { projectCommand } from "./project-cli.js";
import { remoteCommand } from "./remote-cli.js";
import { serviceCommand, type ServiceEnv } from "./service-cli.js";
import { taskCommand } from "./task-cli.js";

/** Recognisable secret. It is an argument (or a path argument) and must never reach a line. */
const SECRET = "sk-ant-api03-SECRETKEY";
/** Same token in kebab-case, for arguments that have to be ids. */
const SECRET_ID = "sk-ant-api03-secretkey";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "boof-cli-audit-"));
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
  expect(typeof line.ts).toBe("string");
  expect(typeof line.ms).toBe("number");
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

async function gitRepo(parent: string, name: string): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  await execCommand("git", ["init", "-q"], { cwd: dir });
  return realpath(dir);
}

const goalXml = `<?xml version="1.0" encoding="UTF-8"?>
<boof>
  <overal><goal>Core ${SECRET}</goal><stack>TypeScript</stack><rules><do>Test.</do></rules></overal>
  <progress>
    <status><versions><version number="1" status="plan">seed</version></versions></status>
    <tests><strategy>TDD</strategy><technology>vitest</technology><run>npm test</run></tests>
  </progress>
</boof>`;

async function addProject(root: string, repo: string, id = "shop"): Promise<void> {
  const code = await projectCommand(
    ["add", repo, "--id", id, "--default", "-d", root],
    () => root,
    () => {},
    () => {},
  );
  expect(code).toBe(0);
}

describe("hand-written CLI audit", () => {
  it("project add and remove write one line; list and usage write none", async () => {
    const root = await scratch();
    const parent = await scratch();
    const repo = await gitRepo(parent, "repo");
    const out: string[] = [];
    const code = await projectCommand(
      ["add", repo, "--id", "shop", "--default", "--brief", SECRET, "-d", root],
      () => root,
      (l) => out.push(l),
      () => {},
    );
    expect(code).toBe(0);
    expect(out).toEqual([`Added project 'shop' (${repo})`, "'shop' is now the default project"]);
    const added = await auditLines(root);
    expect(added).toHaveLength(1);
    assertLine(added[0]!, { action: "cli:project.add", outcome: "ok", project: "shop" });

    expect(
      await projectCommand(
        ["list", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(0);
    expect(
      await projectCommand(
        ["add", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    expect(await auditLines(root)).toHaveLength(1);

    expect(
      await projectCommand(
        ["remove", "shop", SECRET, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(0);
    const removed = await auditLines(root);
    expect(removed).toHaveLength(2);
    assertLine(removed[1]!, { action: "cli:project.remove", outcome: "ok", project: "shop" });
  });

  it("project add and remove record a domain error and nothing when audit is off", async () => {
    const root = await scratch();
    const parent = await scratch();
    const bare = join(parent, SECRET);
    await mkdir(bare);
    expect(
      await projectCommand(
        ["add", bare, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    const failed = await auditLines(root);
    expect(failed).toHaveLength(1);
    assertLine(failed[0]!, { action: "cli:project.add", outcome: "error", error: "not_git_repo" });

    const missing = await scratch();
    expect(
      await projectCommand(
        ["remove", "missing", SECRET, "-d", missing],
        () => missing,
        () => {},
        () => {},
      ),
    ).toBe(1);
    assertLine((await auditLines(missing))[0]!, {
      action: "cli:project.remove",
      outcome: "error",
      project: "missing",
      error: "not_found",
    });

    await disableAudit(root);
    const before = (await auditLines(root)).length;
    expect(
      await projectCommand(
        ["add", bare, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    expect(await auditLines(root)).toHaveLength(before);
    await disableAudit(missing);
    const beforeMissing = (await auditLines(missing)).length;
    expect(
      await projectCommand(
        ["remove", "missing", SECRET, "-d", missing],
        () => missing,
        () => {},
        () => {},
      ),
    ).toBe(1);
    expect(await auditLines(missing)).toHaveLength(beforeMissing);
  });

  it("epic writes are audited; list and a missing title are not", async () => {
    const root = await scratch();
    const parent = await scratch();
    await addProject(root, await gitRepo(parent, "repo"));
    const before = (await auditLines(root)).length;

    expect(
      await epicCommand(
        ["add", `Ship ${SECRET}`, "--id", "ship", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(0);
    const added = (await auditLines(root)).slice(before);
    expect(added).toHaveLength(1);
    assertLine(added[0]!, { action: "cli:epic.add", outcome: "ok", project: "shop" });

    expect(
      await epicCommand(
        ["list", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(0);
    expect(
      await epicCommand(
        ["add", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    expect(await auditLines(root)).toHaveLength(before + 1);

    expect(
      await epicCommand(
        ["add", `Again ${SECRET}`, "--id", "ship", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    const dup = (await auditLines(root)).slice(before + 1);
    expect(dup).toHaveLength(1);
    assertLine(dup[0]!, {
      action: "cli:epic.add",
      outcome: "error",
      project: "shop",
      error: "exists",
    });

    const n = (await auditLines(root)).length;
    expect(
      await epicCommand(
        ["archive", "ship", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(0);
    assertLine((await auditLines(root))[n]!, {
      action: "cli:epic.archive",
      outcome: "ok",
      project: "shop",
    });
    expect(
      await epicCommand(
        ["archive", SECRET, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    assertLine((await auditLines(root)).at(-1)!, {
      action: "cli:epic.archive",
      outcome: "error",
      project: "shop",
      error: "not_found",
    });

    expect(
      await epicCommand(
        ["remove", "ship", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(0);
    assertLine((await auditLines(root)).at(-1)!, {
      action: "cli:epic.remove",
      outcome: "ok",
      project: "shop",
    });
    expect(
      await epicCommand(
        ["remove", SECRET, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    assertLine((await auditLines(root)).at(-1)!, {
      action: "cli:epic.remove",
      outcome: "error",
      project: "shop",
      error: "epic_not_found",
    });

    await disableAudit(root);
    const frozen = (await auditLines(root)).length;
    expect(
      await epicCommand(
        ["archive", SECRET, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    expect(
      await epicCommand(
        ["remove", SECRET, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    expect(
      await epicCommand(
        ["add", `Off ${SECRET}`, "--id", "ship", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(0);
    expect(await auditLines(root)).toHaveLength(frozen);
  });

  it("task move is audited; list is not", async () => {
    const root = await scratch();
    const parent = await scratch();
    await addProject(root, await gitRepo(parent, "repo"));
    expect(
      await epicCommand(
        ["add", "Hooks", "--id", SECRET_ID, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(0);
    const dir = new ProjectStore(root).dir("shop");
    await createTaskInHierarchy(
      dir,
      newTask(
        {
          id: "job",
          title: "job",
          status: "pending",
          priority: 1,
          skip: false,
          labels: [],
          command: null,
          attachments: [],
          questions: "none",
          runs: 1,
          completedRuns: 0,
          created: "",
          updated: "",
        },
        "prompt",
      ),
      { by: "test" },
    );
    const before = (await auditLines(root)).length;
    const out: string[] = [];
    expect(
      await taskCommand(
        ["move", "job", "--epic", SECRET_ID, "-d", root],
        () => root,
        (l) => out.push(l),
        () => {},
      ),
    ).toBe(0);
    expect(out).toEqual([`Moved task 'job' into epic '${SECRET_ID}'`]);
    const moved = (await auditLines(root)).slice(before);
    expect(moved).toHaveLength(1);
    assertLine(moved[0]!, { action: "cli:task.move", outcome: "ok", project: "shop" });

    expect(
      await taskCommand(
        ["list", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(0);
    expect(
      await taskCommand(
        ["move", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    expect(await auditLines(root)).toHaveLength(before + 1);

    expect(
      await taskCommand(
        ["move", SECRET, "--epic", "none", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    assertLine((await auditLines(root)).at(-1)!, {
      action: "cli:task.move",
      outcome: "error",
      project: "shop",
      error: "not_found",
    });

    await disableAudit(root);
    const frozen = (await auditLines(root)).length;
    expect(
      await taskCommand(
        ["move", SECRET, "--epic", "none", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    expect(await auditLines(root)).toHaveLength(frozen);
  });

  it("plan import and sync are audited; export, dry-run and a missing flag are not", async () => {
    const root = await scratch();
    const parent = await scratch();
    const repo = await gitRepo(parent, "repo");
    await mkdir(join(repo, "core"));
    await writeFile(join(repo, "core", "goal.boof.xml"), goalXml);
    await addProject(root, repo);
    const before = (await auditLines(root)).length;

    const out: string[] = [];
    expect(
      await planCommand(
        ["import", "--project", "shop", "--plan", "repo", "-d", root],
        () => root,
        (l) => out.push(l),
        () => {},
      ),
    ).toBe(0);
    expect(out[0]).toMatch(/^Plan 'repo' in project 'shop'/);
    const imported = (await auditLines(root)).slice(before);
    expect(imported).toHaveLength(1);
    assertLine(imported[0]!, { action: "cli:plan.import", outcome: "ok", project: "shop" });

    const afterImport = (await auditLines(root)).length;
    expect(
      await planCommand(
        ["sync", "--project", "shop", "--plan", "repo", "--dry-run", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(0);
    expect(
      await planCommand(
        ["export", "--project", "shop", "--plan", "repo", "--out", join(parent, "out"), "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(0);
    expect(
      await planCommand(
        ["sync", "--project", "shop", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    expect(await auditLines(root)).toHaveLength(afterImport);

    expect(
      await planCommand(
        ["sync", "--project", "shop", "--plan", "repo", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(0);
    assertLine((await auditLines(root)).at(-1)!, {
      action: "cli:plan.sync",
      outcome: "ok",
      project: "shop",
    });

    const empty = await scratch();
    const emptyRepo = await gitRepo(parent, "empty");
    await addProject(empty, emptyRepo);
    const emptyBefore = (await auditLines(empty)).length;
    expect(
      await planCommand(
        ["import", "--project", "shop", "--plan", SECRET, "-d", empty],
        () => empty,
        () => {},
        () => {},
      ),
    ).toBe(1);
    const noGoals = (await auditLines(empty)).slice(emptyBefore);
    expect(noGoals).toHaveLength(1);
    assertLine(noGoals[0]!, {
      action: "cli:plan.import",
      outcome: "error",
      project: "shop",
      error: "no_goals",
    });

    expect(
      await planCommand(
        ["sync", "--project", "shop", "--plan", SECRET_ID, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    assertLine((await auditLines(root)).at(-1)!, {
      action: "cli:plan.sync",
      outcome: "error",
      project: "shop",
      error: "not_found",
    });

    await disableAudit(root);
    const frozen = (await auditLines(root)).length;
    expect(
      await planCommand(
        ["sync", "--project", "shop", "--plan", SECRET_ID, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    expect(await auditLines(root)).toHaveLength(frozen);
    await disableAudit(empty);
    const frozenEmpty = (await auditLines(empty)).length;
    expect(
      await planCommand(
        ["import", "--project", "shop", "--plan", SECRET, "-d", empty],
        () => empty,
        () => {},
        () => {},
      ),
    ).toBe(1);
    expect(await auditLines(empty)).toHaveLength(frozenEmpty);
  });

  it("auth add, revoke and rotate are audited; list and a missing flag are not", async () => {
    const root = await scratch();
    const out: string[] = [];
    expect(
      await authCommand(
        ["add", "--name", `Harness ${SECRET}`, "--scopes", "tasks:read", "-d", root],
        () => root,
        (l) => out.push(l),
        () => {},
      ),
    ).toBe(0);
    const key = out.find((l) => l.includes("boof_"))?.trim();
    expect(key).toBeTruthy();
    const created = await auditLines(root);
    expect(created).toHaveLength(1);
    assertLine(created[0]!, { action: "cli:auth.add", outcome: "ok" });
    expect(JSON.stringify(created)).not.toContain(key!);

    expect(
      await authCommand(
        ["list", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(0);
    expect(
      await authCommand(
        ["add", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    expect(
      await authCommand(
        ["revoke", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    expect(await auditLines(root)).toHaveLength(1);

    const id = out[0]!.match(/"([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(
      await authCommand(
        ["rotate", id!, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(0);
    assertLine((await auditLines(root)).at(-1)!, { action: "cli:auth.rotate", outcome: "ok" });
    expect(
      await authCommand(
        ["revoke", id!, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(0);
    assertLine((await auditLines(root)).at(-1)!, { action: "cli:auth.revoke", outcome: "ok" });

    expect(
      await authCommand(
        ["revoke", SECRET, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    assertLine((await auditLines(root)).at(-1)!, {
      action: "cli:auth.revoke",
      outcome: "error",
      error: "not_found",
    });
    expect(
      await authCommand(
        ["rotate", SECRET, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    assertLine((await auditLines(root)).at(-1)!, {
      action: "cli:auth.rotate",
      outcome: "error",
      error: "not_found",
    });

    await expect(
      authCommand(
        ["add", "--name", "bad", "--scopes", "tasks:read", "--projects", SECRET, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).rejects.toThrow();
    assertLine((await auditLines(root)).at(-1)!, {
      action: "cli:auth.add",
      outcome: "error",
      error: "invalid_input",
    });

    await disableAudit(root);
    const frozen = (await auditLines(root)).length;
    expect(
      await authCommand(
        ["revoke", SECRET, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    expect(
      await authCommand(
        ["rotate", SECRET, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    await expect(
      authCommand(
        ["add", "--name", "bad", "--scopes", "tasks:read", "--projects", SECRET, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).rejects.toThrow();
    expect(await auditLines(root)).toHaveLength(frozen);
  });

  it("remote setup and disable are audited; status is not", async () => {
    const root = await scratch();
    const out: string[] = [];
    expect(
      await remoteCommand(
        [
          "setup",
          "--hostname",
          "example.com",
          "--allowed-root",
          `/tmp/${SECRET}`,
          "--no-key",
          "-d",
          root,
        ],
        () => root,
        (l) => out.push(l),
        () => {},
      ),
    ).toBe(0);
    expect(out.join("\n")).toContain("security.auth.mode           = required");
    const setup = await auditLines(root);
    expect(setup).toHaveLength(1);
    assertLine(setup[0]!, { action: "cli:remote.setup", outcome: "ok" });

    expect(
      await remoteCommand(
        ["status", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(0);
    expect(await auditLines(root)).toHaveLength(1);

    expect(
      await remoteCommand(
        ["disable", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(0);
    assertLine((await auditLines(root)).at(-1)!, { action: "cli:remote.disable", outcome: "ok" });

    const bare = join(await scratch(), SECRET);
    await mkdir(bare);
    expect(
      await remoteCommand(
        ["disable", "-d", bare],
        () => bare,
        () => {},
        () => {},
      ),
    ).toBe(1);
    assertLine((await auditLines(bare))[0]!, {
      action: "cli:remote.disable",
      outcome: "error",
      error: "not_configured",
    });

    expect(
      await authCommand(
        ["add", "--name", SECRET, "--scopes", "tasks:read", "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(0);
    expect(
      await remoteCommand(
        ["setup", "--hostname", "example.com", "--name", SECRET, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    assertLine((await auditLines(root)).at(-1)!, {
      action: "cli:remote.setup",
      outcome: "error",
      error: "client_exists",
    });

    await disableAudit(root);
    const frozen = (await auditLines(root)).length;
    expect(
      await remoteCommand(
        ["setup", "--hostname", "example.com", "--name", SECRET, "-d", root],
        () => root,
        () => {},
        () => {},
      ),
    ).toBe(1);
    expect(await auditLines(root)).toHaveLength(frozen);
    await disableAudit(bare);
    const frozenBare = (await auditLines(bare)).length;
    expect(
      await remoteCommand(
        ["disable", "-d", bare],
        () => bare,
        () => {},
        () => {},
      ),
    ).toBe(0);
    expect(await auditLines(bare)).toHaveLength(frozenBare);
  });

  it("service install and uninstall are audited; status and logs are not", async () => {
    const root = await scratch();
    const home = await scratch();
    const script = join(home, "boof-runner.js");
    await writeFile(script, "");
    let failOn: string | null = null;
    const env: ServiceEnv = {
      platform: "linux",
      home,
      user: "tester",
      path: "/usr/bin",
      nodePath: "/usr/bin/node",
      scriptPath: script,
      run: async (cmd, args) => {
        const line = `${cmd} ${args.join(" ")}`;
        if (failOn && line.includes(failOn)) return { code: 1, stdout: "", stderr: "boom" };
        if (line.includes(" status ")) return { code: 0, stdout: "active\n", stderr: "" };
        if (cmd === "loginctl") return { code: 0, stdout: "Linger=yes\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      stream: async () => 0,
      health: async () => ({ ok: true, summary: "ok" }),
    };
    const run = (argv: string[], over: Partial<ServiceEnv> = {}) =>
      serviceCommand(
        argv,
        () => root,
        () => {},
        () => {},
        { ...env, ...over },
      );

    expect(await run(["install", "-d", root, "--env", `API_TOKEN=${SECRET}`])).toBe(0);
    const installed = await auditLines(root);
    expect(installed).toHaveLength(1);
    assertLine(installed[0]!, { action: "cli:service.install", outcome: "ok" });
    expect(
      await readFile(join(home, ".config/systemd/user/boof-runner.service"), "utf8"),
    ).toContain(SECRET);

    const n = (await auditLines(root)).length;
    expect(await run(["status"])).toBe(0);
    expect(await run(["logs"])).toBe(0);
    expect(await run(["install", "--port", "nope"])).toBe(1);
    expect(await auditLines(root)).toHaveLength(n);

    failOn = "daemon-reload";
    expect(await run(["install", "-d", root, "--env", `API_TOKEN=${SECRET}`])).toBe(1);
    assertLine((await auditLines(root)).at(-1)!, {
      action: "cli:service.install",
      outcome: "error",
      error: "systemctl",
    });
    failOn = null;

    const name = `unit-${SECRET}`;
    expect(await run(["uninstall", "--name", name, "-d", root])).toBe(0);
    assertLine((await auditLines(root)).at(-1)!, {
      action: "cli:service.uninstall",
      outcome: "ok",
    });
    expect(await run(["uninstall", "--name", name, "-d", root], { platform: "darwin" })).toBe(1);
    assertLine((await auditLines(root)).at(-1)!, {
      action: "cli:service.uninstall",
      outcome: "error",
      error: "no_systemd",
    });

    await disableAudit(root);
    const frozen = (await auditLines(root)).length;
    expect(await run(["install", "-d", root, "--env", `API_TOKEN=${SECRET}`])).toBe(0);
    expect(await run(["uninstall", "--name", name, "-d", root], { platform: "darwin" })).toBe(1);
    expect(await auditLines(root)).toHaveLength(frozen);
  });
});
