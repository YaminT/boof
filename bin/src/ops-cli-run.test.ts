import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskService } from "@boof-runner/api";
import { AuthStore, SecuritySettingsSchema, SettingsStore, execCommand } from "@boof/heart";
import { MockTool, ToolRegistry } from "@boof-runner/runner";
import { opsCommand } from "./ops-cli.js";

let base: string;
let root: string;
let repo: string;
let out: string[];
let errs: string[];
let written: Uint8Array[];

const services = (r: string) => new TaskService(r, new ToolRegistry([new MockTool()]));
const run = (argv: string[], signal?: AbortSignal) =>
  opsCommand(
    argv,
    () => root,
    { services, signal },
    {
      out: (l) => out.push(l),
      err: (l) => errs.push(l),
      write: (b) => written.push(b),
    },
  );
const text = () => out.join("\n");

// A minimal 1x1 PNG.
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "boof-opsrun-")));
  root = join(base, "data");
  repo = join(base, "shop");
  await mkdir(repo, { recursive: true });
  await execCommand("git", ["init", "-q"], { cwd: repo });
  out = [];
  errs = [];
  written = [];
});
afterEach(() => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

/** A registered project `shop` and the default project set. */
async function seed(withDefault = true) {
  expect(await run(["projects", "create", "--working-directory", repo, "--id", "shop"])).toBe(0);
  if (withDefault) {
    expect(await run(["settings", "update", "--default-project", "shop"])).toBe(0);
  }
  out.length = 0;
  errs.length = 0;
}
async function makeTask(title = "Fix X"): Promise<string> {
  expect(await run(["tasks", "create", "--title", title, "--json"])).toBe(0);
  const id = JSON.parse(text()).frontmatter.id as string;
  out.length = 0;
  return id;
}

describe("generated commands", () => {
  it("ops lists every generated command", async () => {
    expect(await run(["ops"])).toBe(0);
    for (const c of ["tasks create", "auth clients revoke", "plans replace-goals"]) {
      expect(text(), c).toContain(c);
    }
  });

  it("creates a project and a task, then lists them as JSON", async () => {
    expect(await run(["projects", "create", "--working-directory", repo, "--id", "shop"])).toBe(0);
    expect(out.join("\n")).toMatch(/shop/);
    expect(await run(["settings", "update", "--default-project", "shop"])).toBe(0);
    out.length = 0;
    expect(await run(["tasks", "create", "--title", "Fix X"])).toBe(0);
    out.length = 0;
    expect(await run(["tasks", "list", "--json"])).toBe(0);
    const list = JSON.parse(text());
    expect(list.items.map((t: { frontmatter: { id: string } }) => t.frontmatter.id)).toEqual([
      "fix-x",
    ]);
  });

  it("a missing task exits 2", async () => {
    await seed();
    expect(await run(["tasks", "get", "--project", "shop", "--task-id", "nope"])).toBe(2);
    expect(errs[0]).toMatch(/^tasks get: not_found:/);
  });

  it("--json errors are the REST body", async () => {
    await seed();
    expect(await run(["tasks", "get", "--project", "shop", "--task-id", "nope", "--json"])).toBe(2);
    expect(JSON.parse(errs[0]!).error.code).toBe("not_found");
  });

  it("a scope refusal exits 3", async () => {
    await seed();
    await new AuthStore(root).create({ name: "reader", scopes: ["tasks:read"], trust: "trusted" });
    expect(
      await run(["--client", "reader", "tasks", "create", "--project", "shop", "--title", "x"]),
    ).toBe(3);
    expect(errs.join("\n")).toContain("forbidden_scope");
  });

  it("review trust applies to a --client", async () => {
    await seed();
    const id = await makeTask();
    await new AuthStore(root).create({ name: "rev", scopes: ["tasks:write"], trust: "review" });
    expect(
      await run(["--client", "rev", "tasks", "queue", "--project", "shop", "--task-id", id]),
    ).toBe(3);
    expect(errs.join("\n")).toContain("forbidden_trust");
  });

  it("required mode needs --client", async () => {
    await seed();
    const settings = new SettingsStore(root);
    const cur = await settings.load();
    await settings.save({
      ...cur,
      security: SecuritySettingsSchema.parse({ ...cur.security, auth: { mode: "required" } }),
    });
    await new AuthStore(root).create({ name: "reader", scopes: ["projects:read"] });
    expect(await run(["projects", "list"])).toBe(3);
    expect(errs.join("\n")).toContain("pass --client <id>");
    out.length = 0;
    expect(await run(["--client", "reader", "projects", "list"])).toBe(0);
  });

  it("disabling MCP does not stop the CLI", async () => {
    await seed();
    const settings = new SettingsStore(root);
    await settings.save({ ...(await settings.load()), mcp: { enabled: false } });
    expect(await run(["projects", "list"])).toBe(0);
  });

  it("--help needs no data root", async () => {
    expect(await run(["tasks", "create", "--help"])).toBe(0);
    expect(text()).toContain("--project-id");
    expect(text()).toContain("Scope: tasks:write");
    expect(text()).toMatch(/--title string\s+required/);
    expect(existsSync(root)).toBe(false);
  });

  it("an area lists its commands", async () => {
    expect(await run(["tasks"])).toBe(1);
    expect(text()).toContain("tasks create");
    out.length = 0;
    expect(await run(["tasks", "--help"])).toBe(0);
    out.length = 0;
    expect(await run(["tasks", "frobnicate"])).toBe(1);
    expect(text()).toContain("tasks create");
  });

  it("account operation help includes the better-ccflare credit line", async () => {
    expect(await run(["accounts", "--help"])).toBe(0);
    expect(text()).toContain(
      "Account pooling by better-ccflare (MIT, © 2025 snipeship & tombii), a fork of ccflare by snipeship.",
    );
  });

  it("bad usage exits 1", async () => {
    await seed();
    expect(await run(["tasks", "create", "--nope"])).toBe(1);
    expect(errs.join("\n")).toContain("unknown option --nope");
    expect(await run(["--client", "Bad Id", "tasks", "list"])).toBe(1);
  });

  it("a project-scoped command with no project and no default says so", async () => {
    await seed(false);
    expect(await run(["tasks", "list"])).toBe(1);
    expect(errs[0]).toContain("no project: pass --project <id>");
  });

  it("human mode prints a one-time key, --json does not add a key line", async () => {
    expect(await run(["auth", "clients", "create", "--name", "ci", "--scopes", "tasks:read"])).toBe(
      0,
    );
    expect(out.some((l) => /^key: boof_/.test(l))).toBe(true);
    out.length = 0;
    expect(
      await run(["auth", "clients", "create", "--name", "ci2", "--scopes", "tasks:read", "--json"]),
    ).toBe(0);
    expect(out.some((l) => /^key:/.test(l))).toBe(false);
    expect(JSON.parse(text()).key).toMatch(/^boof_/);
    out.length = 0;
    expect(await run(["webhooks", "create", "--url", "https://93.184.216.34/hook"])).toBe(0);
    expect(out.some((l) => /^secret: whsec_/.test(l))).toBe(true);
  });

  it("Ctrl-C ends a wait at once with exit 130", async () => {
    await seed();
    const id = await makeTask();
    const started = Date.now();
    const code = await run(
      [
        "tasks",
        "wait",
        "--project",
        "shop",
        "--task-id",
        id,
        "--until",
        "done",
        "--timeout-seconds",
        "30",
      ],
      AbortSignal.abort(),
    );
    expect(code).toBe(130);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("warnings go to stderr and keep --json stdout one document", async () => {
    await seed();
    const parent = await makeTask("Parent");
    const child = await makeTask("Child");
    expect(await run(["tasks", "move", "--task-id", child, "--parent-id", parent, "--json"])).toBe(
      0,
    );
    out.length = 0;
    expect(await run(["tasks", "queue", "--task-id", parent, "--json"])).toBe(0);
    expect(JSON.parse(text()).frontmatter.status).toBe("pending");
    expect(errs.some((l) => l.startsWith("warning (subtasks_open)"))).toBe(true);
  });

  it("attachments round-trip through --file and --out", async () => {
    await seed();
    const id = await makeTask();
    await writeFile(join(base, "a.png"), png);
    expect(
      await run([
        "tasks",
        "attachments",
        "add",
        "--task-id",
        id,
        "--file",
        join(base, "a.png"),
        "--json",
      ]),
    ).toBe(0);
    const stored = JSON.parse(text()).frontmatter.attachments[0].name as string;
    out.length = 0;
    const target = join(base, "b.png");
    expect(
      await run([
        "tasks",
        "attachments",
        "get",
        "--task-id",
        id,
        "--attachment-name",
        stored,
        "--out",
        target,
      ]),
    ).toBe(0);
    expect(Buffer.from(await readFile(target)).equals(Buffer.from(png))).toBe(true);
    expect(
      await run(["tasks", "attachments", "get", "--task-id", id, "--attachment-name", stored]),
    ).toBe(1);
    expect(errs.join("\n")).toContain("pass --out <file>");
    expect(
      await run([
        "tasks",
        "attachments",
        "get",
        "--task-id",
        id,
        "--attachment-name",
        stored,
        "--out",
        "-",
      ]),
    ).toBe(0);
    expect(written).toHaveLength(1);
  });

  it("refuses binary output to a terminal", async () => {
    await seed();
    const id = await makeTask();
    await writeFile(join(base, "a.png"), png);
    await run([
      "tasks",
      "attachments",
      "add",
      "--task-id",
      id,
      "--file",
      join(base, "a.png"),
      "--json",
    ]);
    const stored = JSON.parse(text()).frontmatter.attachments[0].name as string;
    errs.length = 0;
    const code = await opsCommand(
      ["tasks", "attachments", "get", "--task-id", id, "--attachment-name", stored, "--out", "-"],
      () => root,
      { services },
      { out: () => {}, err: (l) => errs.push(l), write: (b) => written.push(b), stdoutIsTty: true },
    );
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("binary output to a terminal");
    expect(written).toHaveLength(0);
  });

  it("the help points secret-bearing input to --input @file", async () => {
    expect(await run(["webhooks", "create", "--help"])).toBe(0);
    expect(text()).toMatch(/--input @file/);
    expect(text()).toMatch(/shell history/);
  });

  it("refuses --kind ui like auth add does", async () => {
    expect(
      await run([
        "auth",
        "clients",
        "create",
        "--name",
        "x",
        "--scopes",
        "tasks:read",
        "--kind",
        "ui",
      ]),
    ).toBe(1);
    expect(errs.join("\n")).toContain("ui");
  });

  it("checks the identity before it creates or migrates a data root", async () => {
    const elsewhere = join(base, "never-created");
    expect(await run(["--client", "nobody", "-d", elsewhere, "projects", "list"])).toBe(3);
    expect(existsSync(elsewhere)).toBe(false);
  });

  describe("audit", () => {
    const auditLines = async () => {
      const dir = join(root, "audit");
      const files = await readdir(dir).catch(() => []);
      return (await Promise.all(files.map((f) => readFile(join(dir, f), "utf8"))))
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    };

    it("every generated command that runs an operation appends one audit line, no values", async () => {
      await seed();
      const before = (await auditLines()).length;
      expect(await run(["tasks", "create", "--title", "T", "--prompt", "SECRET-PROMPT"])).toBe(0);
      expect(await run(["tasks", "get", "--task-id", "no-such-task"])).not.toBe(0);
      const lines = (await auditLines()).slice(before);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        principal: "local",
        kind: "local",
        action: "cli:tasks.create",
        via: "cli",
        project: "shop",
        outcome: "ok",
      });
      expect(lines[1]).toMatchObject({
        action: "cli:tasks.get",
        project: "shop",
        outcome: "error",
        error: "not_found",
      });
      expect(typeof lines[0]!.ms).toBe("number");
      expect(JSON.stringify(lines)).not.toMatch(/SECRET/);
    });

    it("a --client call is recorded under that client", async () => {
      await seed();
      const { client } = await new AuthStore(root).create({
        name: "reader",
        scopes: ["tasks:read"],
        trust: "review",
      });
      expect(await run(["--client", client.id, "tasks", "list"])).toBe(0);
      const last = (await auditLines()).at(-1)!;
      expect(last).toMatchObject({
        principal: client.id,
        kind: "client",
        action: "cli:tasks.list",
      });
    });

    it("writes nothing when security.audit.enabled is false", async () => {
      await seed();
      const settings = await new SettingsStore(root).load();
      await new SettingsStore(root).save({
        ...settings,
        security: SecuritySettingsSchema.parse({
          ...settings.security,
          audit: { enabled: false, retentionDays: 90 },
        }),
      });
      const before = (await auditLines()).length;
      expect(await run(["tasks", "list"])).toBe(0);
      expect((await auditLines()).length).toBe(before);
    });
  });
});
