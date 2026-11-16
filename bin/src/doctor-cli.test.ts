import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskService } from "@boof/heart-server";
import { ToolRegistry, type Tool } from "@boof/runner";
import { DoctorCancelled, doctorCommand, type DoctorDeps, type DoctorIo } from "./doctor-cli.js";

let scratch: string;
let data: string;
let savedHome: string | undefined;
let savedProfile: string | undefined;

const fakeTool = (id: string, installed: boolean): Tool =>
  ({
    id,
    displayName: `Fake ${id}`,
    defaultModels: [],
    installed: async () =>
      installed
        ? { installed: true, version: "1.0", path: `/x/${id}`, message: "m" }
        : { installed: false, message: `${id} not found on PATH` },
    detect: async () => {
      throw new Error("a health probe must not run");
    },
    listModels: async () => [],
    run: async () => {
      throw new Error("not used");
    },
  }) as Tool;

const deps = (tools: Tool[], extra: Partial<DoctorDeps> = {}): DoctorDeps => ({
  defaultRoot: () => data,
  service: (root) => new TaskService(root, new ToolRegistry(tools)),
  ...extra,
});

/** A scripted terminal: answers in order; records what was asked and printed. */
const terminal = (answers: string[], isTTY = true) => {
  const asked: { question: string; hidden: boolean }[] = [];
  const lines: string[] = [];
  const ran: string[][] = [];
  const io: DoctorIo = {
    isTTY,
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    ask: async (question, opts) => {
      asked.push({ question, hidden: opts?.hidden === true });
      return answers.shift() ?? "";
    },
    run: async (command, args) => {
      ran.push([command, ...args]);
      return 0;
    },
    close: () => {},
  };
  return { io, asked, lines, ran };
};

let log: { mock: { calls: unknown[][] } };
const posix = process.platform !== "win32";
const printed = () => log.mock.calls.map((c) => String(c[0])).join("\n");

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "boof-doctor-"));
  data = join(scratch, "data");
  await mkdir(data, { mode: 0o700 });
  savedHome = process.env.HOME;
  savedProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
  log = vi.spyOn(console, "log").mockImplementation(() => {}) as unknown as typeof log;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile;
  await chmod(data, 0o700).catch(() => {});
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("boof doctor", () => {
  it("prints the same checks as the web Doctor and exits 0 when an agent is ready", async () => {
    expect(await doctorCommand(["-d", data], deps([fakeTool("codex", true)]))).toBe(0);
    const out = printed();
    for (const label of [
      "Coding agents",
      "better-ccflare gateway",
      "Projects folder",
      "git",
      "Data folder",
      "Sandbox",
    ])
      expect(out).toContain(label);
    expect(out).toMatch(/✓ Coding agents\s+1 ready/);
    expect(out).toMatch(/! better-ccflare gateway\s+Not configured\./);
    expect(out).toContain("codex");
    expect(out).toContain("ready");
    expect(out).toContain("All set: an agent is ready");
  });

  it("exits 1 and says why when no agent is ready", async () => {
    expect(await doctorCommand(["-d", data], deps([fakeTool("codex", false)]))).toBe(1);
    const out = printed();
    expect(out).toContain("Cannot run tasks yet: no coding agent is ready");
    expect(out).toMatch(/✗ Coding agents/);
    expect(out).toContain("not ready");
  });

  it("--json prints a parseable document with the checks", async () => {
    expect(await doctorCommand(["--json", "-d", data], deps([fakeTool("codex", true)]))).toBe(0);
    const doc = JSON.parse(printed());
    expect(doc.ok).toBe(true);
    expect(doc.checks.map((c: { id: string }) => c.id)).toEqual([
      "agents",
      "gateway",
      "projectsRoot",
      "git",
      "dataRoot",
      "sandbox",
    ]);
  });

  it("refuses unknown words and flags, --yes without --fix, and --json with --fix", async () => {
    const d = deps([fakeTool("codex", true)]);
    expect(await doctorCommand(["nope"], d)).toBe(2);
    expect(await doctorCommand(["--bad"], d)).toBe(2);
    expect(await doctorCommand(["--yes"], d)).toBe(2);
    expect(await doctorCommand(["--json", "--fix"], d)).toBe(2);
    expect(await doctorCommand(["-d"], d)).toBe(2);
  });
});

describe("boof doctor --fix", () => {
  it("refuses without a terminal (exit 2) and changes nothing", async () => {
    const t = terminal([], false);
    expect(
      await doctorCommand(["--fix", "-d", data], deps([fakeTool("codex", true)], { io: t.io })),
    ).toBe(2);
    expect(t.lines.join("\n")).toContain("interactive terminal");
    expect(t.asked).toEqual([]);
    await expect(stat(join(scratch, "boof-projects"))).rejects.toThrow();
  });

  it("creates the projects folder (mode 700) and saves it in settings after y", async () => {
    const folder = join(scratch, "my-projects");
    // gateway: skip, projects folder: y + path, then y to let API clients use it.
    const t = terminal(["n", "y", folder, "y"]);
    const d = deps([fakeTool("codex", true)], { io: t.io });
    expect(await doctorCommand(["--fix", "-d", data], d)).toBe(0);
    if (posix) expect((await stat(folder)).mode & 0o777).toBe(0o700);
    const settings = await new TaskService(data, new ToolRegistry([])).loadSettings();
    expect(settings.projectsRoot).toBe(folder);
    expect(settings.security?.allowedProjectRoots).toContain(folder);
    // The final table is printed again and shows the folder as a pass.
    expect(t.lines.join("\n")).toContain("After the fixes");
    expect(t.lines.join("\n")).toMatch(/✓ Projects folder\s+/);
  });

  it("leaves the projects folder alone when the answer is not y", async () => {
    const t = terminal(["n", "n"]);
    await doctorCommand(["--fix", "-d", data], deps([fakeTool("codex", true)], { io: t.io }));
    await expect(stat(join(scratch, "boof-projects"))).rejects.toThrow();
  });

  it("saves the projects folder without widening allowedProjectRoots when the second question gets n", async () => {
    const folder = join(scratch, "narrow");
    const t = terminal(["n", "y", folder, "n"]);
    await doctorCommand(["--fix", "-d", data], deps([fakeTool("codex", true)], { io: t.io }));
    const settings = await new TaskService(data, new ToolRegistry([])).loadSettings();
    expect(settings.projectsRoot).toBe(folder);
    expect(settings.security?.allowedProjectRoots ?? []).not.toContain(folder);
    expect(t.asked.some((a) => a.question.includes("allowedProjectRoots"))).toBe(true);
  });

  it("refuses ~ and / as the projects folder and saves nothing", async () => {
    for (const typed of ["~", "/"]) {
      const t = terminal(["n", "y", typed]);
      await doctorCommand(["--fix", "-d", data], deps([fakeTool("codex", true)], { io: t.io }));
      expect(t.lines.join("\n")).toContain("Not saved:");
      expect(t.asked.some((a) => a.question.includes("allowedProjectRoots"))).toBe(false);
      const settings = await new TaskService(data, new ToolRegistry([])).loadSettings();
      expect(settings.projectsRoot).toBeUndefined();
    }
  });

  it("refuses the data folder and a folder inside it", async () => {
    const t = terminal(["n", "y", join(data, "projects")]);
    await doctorCommand(["--fix", "-d", data], deps([fakeTool("codex", true)], { io: t.io }));
    expect(t.lines.join("\n")).toContain("Not saved:");
  });

  it.skipIf(!posix)("does not chmod a projects folder that already exists", async () => {
    const shared = join(scratch, "shared");
    await mkdir(shared, { mode: 0o755 });
    await chmod(shared, 0o755);
    const t = terminal(["n", "y", shared, "n"]);
    await doctorCommand(["--fix", "-d", data], deps([fakeTool("codex", true)], { io: t.io }));
    expect((await stat(shared)).mode & 0o777).toBe(0o755);
    const settings = await new TaskService(data, new ToolRegistry([])).loadSettings();
    expect(settings.projectsRoot).toBe(shared);
  });

  it("--yes never adds the folder to allowedProjectRoots", async () => {
    const t = terminal([]);
    await doctorCommand(
      ["--fix", "--yes", "-d", data],
      deps([fakeTool("codex", true)], { io: t.io }),
    );
    const settings = await new TaskService(data, new ToolRegistry([])).loadSettings();
    expect(settings.security?.allowedProjectRoots ?? []).not.toContain(
      join(scratch, "boof-projects"),
    );
  });

  it("a Ctrl-C at a question stops with exit 130 and says so", async () => {
    const t = terminal([]);
    t.io.ask = async () => {
      throw new DoctorCancelled();
    };
    expect(
      await doctorCommand(["--fix", "-d", data], deps([fakeTool("codex", true)], { io: t.io })),
    ).toBe(130);
    expect(t.lines.join("\n")).toContain("Cancelled");
  });

  it("a wrong per-project API key prints a short error and the walkthrough goes on", async () => {
    const svc = new TaskService(data, new ToolRegistry([fakeTool("codex", true)]));
    const repo = join(scratch, "repo");
    await mkdir(repo, { recursive: true });
    vi.spyOn(svc, "listProjects").mockResolvedValue([
      { id: "p1", archived: false },
    ] as unknown as Awaited<ReturnType<typeof svc.listProjects>>);
    const t = terminal(["y", "2", "not-a-key", "n"]);
    expect(
      await doctorCommand(["--fix", "-d", data], deps([], { io: t.io, service: () => svc })),
    ).toBe(0);
    expect(t.lines.join("\n")).toContain("The key was not saved");
    expect(t.lines.join("\n")).toContain("After the fixes");
    expect(t.lines.join("\n")).not.toContain("not-a-key");
  });

  it("a data folder that does not exist yet is a warning, not a failure (exit 0 with an agent)", async () => {
    const missing = join(scratch, "fresh-data");
    expect(await doctorCommand(["-d", missing], deps([fakeTool("codex", true)]))).toBe(0);
    expect(printed()).toMatch(/! Data folder\s+.*does not exist yet/);
  });

  it("names the claude binary, not claude-code, in the ready text", async () => {
    await doctorCommand(["-d", data], deps([fakeTool("claude-code", true)]));
    expect(printed()).toContain("run claude once in a terminal");
    expect(printed()).not.toContain("run claude-code once");
  });

  it("takes the gateway address and a hidden key, stores the key 0600, and never prints it", async () => {
    const secret = "btr-SECRET-key-123";
    // gateway: y, 1, url, hidden key; projects folder: n.
    const t = terminal(["y", "1", "http://127.0.0.1:1", secret, "n"]);
    const d = deps([fakeTool("codex", true)], { io: t.io });
    await doctorCommand(["--fix", "-d", data], d);
    const hidden = t.asked.filter((a) => a.hidden);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]!.question).toContain("key");
    expect(t.asked.filter((a) => !a.hidden).every((a) => !a.question.includes(secret))).toBe(true);
    const file = join(data, "owlish", "secrets.json");
    expect(JSON.parse(await readFile(file, "utf8")).apiKey).toBe(secret);
    if (posix) expect((await stat(file)).mode & 0o777).toBe(0o600);
    const settings = await new TaskService(data, new ToolRegistry([])).loadSettings();
    expect(settings.owlish?.url).toBe("http://127.0.0.1:1");
    const everything = [...t.lines, printed(), ...t.asked.map((a) => a.question)].join("\n");
    expect(everything).not.toContain(secret);
  });

  it("refuses a gateway address the settings do not accept", async () => {
    const t = terminal(["y", "1", "ftp://nope", "", "n"]);
    await doctorCommand(["--fix", "-d", data], deps([fakeTool("codex", true)], { io: t.io }));
    expect(t.lines.join("\n")).toContain("That address is not accepted");
    const settings = await new TaskService(data, new ToolRegistry([])).loadSettings();
    expect(settings.owlish).toBeUndefined();
  });

  it("offers an npm install only after y, and never uses sudo", async () => {
    // agents: decline; then the gateway and the projects folder: skip.
    const no = terminal(["n", "n", "n"]);
    await doctorCommand(
      ["--fix", "-d", data],
      deps([fakeTool("codex", false)], { io: no.io, hasNpm: async () => false }),
    );
    expect(no.ran).toEqual([]);
    expect(no.lines.join("\n")).toContain("npm install -g @openai/codex");

    const go = terminal(["y", "n", "n"]);
    await doctorCommand(
      ["--fix", "-d", data],
      deps([fakeTool("codex", false)], { io: go.io, hasNpm: async () => true }),
    );
    expect(go.ran).toEqual([["npm", "install", "-g", "@openai/codex"]]);
    expect(go.ran.flat()).not.toContain("sudo");
  });

  it("--yes accepts the safe defaults: creates the projects folder, asks no secret, installs nothing", async () => {
    const t = terminal([]);
    const d = deps([fakeTool("codex", false)], { io: t.io, hasNpm: async () => true });
    await doctorCommand(["--fix", "--yes", "-d", data], d);
    expect(t.asked).toEqual([]);
    expect(t.ran).toEqual([]);
    const made = await stat(join(scratch, "boof-projects"));
    expect(made.isDirectory()).toBe(true);
    if (posix) expect(made.mode & 0o777).toBe(0o700);
  });

  it.skipIf(!posix)("makes an unwritable data folder private again after y", async () => {
    if (process.getuid?.() === 0) return; // root can write anywhere: the check never fails
    const d = deps([fakeTool("codex", true)]);
    await chmod(data, 0o500);
    const t = terminal(["n", "n", "y"]);
    await doctorCommand(["--fix", "-d", data], { ...d, io: t.io });
    expect((await stat(data)).mode & 0o777).toBe(0o700);
  });

  it("prints how to install git and never runs it", async () => {
    const t = terminal([]);
    const d = deps([fakeTool("codex", true)], { io: t.io, platform: "linux" });
    const saved = process.env.PATH;
    process.env.PATH = scratch; // no git on PATH
    try {
      await doctorCommand(["--fix", "--yes", "-d", data], d);
    } finally {
      process.env.PATH = saved;
    }
    expect(t.lines.join("\n")).toContain("Install git with your package manager");
    expect(t.ran).toEqual([]);
  });
});
