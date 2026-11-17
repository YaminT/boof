import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskService } from "@boof/heart-server";
import { ToolRegistry, type Tool } from "@boof/runner";
import { doctorCommand, type DoctorIo } from "./doctor-cli.js";

const KEY = "sk-ant-api03-DOCTORKEYDOCTORKEYDOC1";
const CC_KEY = "sk-ant-api03-CCFLAREKEYCCFLAREKEY2";
let scratch: string;
let data: string;
let saved: Record<string, string | undefined>;

const codex: Tool = {
  id: "codex",
  displayName: "Fake codex",
  defaultModels: [],
  installed: async () => ({ installed: true, version: "1", path: "/x/codex", message: "m" }),
  detect: async () => {
    throw new Error("no probe");
  },
  listModels: async () => [],
  run: async () => {
    throw new Error("not used");
  },
} as unknown as Tool;

const terminal = (answers: string[]) => {
  const asked: { question: string; hidden: boolean }[] = [];
  const lines: string[] = [];
  const io: DoctorIo = {
    isTTY: true,
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    ask: async (question, opts) => {
      asked.push({ question, hidden: opts?.hidden === true });
      return answers.shift() ?? "";
    },
    run: async () => 0,
    close: () => {},
  };
  return { io, asked, lines };
};
const svc = () => new TaskService(data, new ToolRegistry([codex]));
const fix = (answers: string[]) => {
  const t = terminal(answers);
  return doctorCommand(["--fix", "-d", data], {
    defaultRoot: () => data,
    service: () => svc(),
    io: t.io,
  }).then((code) => ({ code, ...t }));
};

const makeCcflare = () => {
  const dir = join(scratch, ".config", "better-ccflare");
  return mkdir(dir, { recursive: true }).then(() => {
    const d = new DatabaseSync(join(dir, "better-ccflare.db"));
    d.exec("CREATE TABLE accounts (id TEXT, name TEXT, provider TEXT, api_key TEXT, priority INT)");
    const ins = d.prepare("INSERT INTO accounts VALUES (?, ?, ?, ?, ?)");
    ins.run("1", "sub1", "anthropic", null, 0);
    ins.run("2", "sub2", "anthropic", null, 1);
    ins.run("3", "console", "claude-console-api", CC_KEY, 2);
    d.close();
  });
};

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "boof-doctor-pool-"));
  data = join(scratch, "data");
  await mkdir(data, { mode: 0o700 });
  saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await (await svc().internalPool()).stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("boof doctor --fix: the built-in account pool", () => {
  it("Enter at the first prompt switches to the pool and a pasted key is never echoed", async () => {
    // pool: Enter (yes), key (hidden), name, projects folder: n
    const r = await fix(["", KEY, "work", "n"]);
    expect(r.asked[0]!.question).toBe(
      "Use boof's built-in account pool for Anthropic API keys? [Y/n] ",
    );
    const key = r.asked.find((a) => a.question.startsWith("Paste an Anthropic API key"))!;
    expect(key.hidden).toBe(true);
    expect(r.asked.filter((a) => !a.hidden).every((a) => !a.question.includes(KEY))).toBe(true);
    const everything = [...r.lines, ...r.asked.map((a) => a.question)].join("\n");
    expect(everything).not.toContain(KEY);
    expect(everything).toContain('Added the account "work"');
    const s = await svc().loadSettings();
    expect(s.gateway?.mode).toBe("internal");
    const stored = JSON.parse(await readFile(join(data, "gateway", "accounts.json"), "utf8"));
    expect(stored.accounts[0]).toMatchObject({ name: "work", apiKey: KEY });
    expect(everything).toMatch(/Account pool\s+1 of 1 account usable/);
  });

  it("a rejected key prints a short error without the key", async () => {
    const r = await fix(["y", "not-a-key-at-all", "x", "n"]);
    const out = r.lines.join("\n");
    expect(out).toContain("The key was not saved");
    expect(out).not.toContain("not-a-key-at-all");
  });

  it("offers the better-ccflare import first, with counts, and imports without printing keys", async () => {
    await makeCcflare();
    const r = await fix(["y", "y", "n"]);
    const offer = r.asked[1]!.question;
    expect(offer).toBe(
      "Import 1 API-key account from better-ccflare? 2 other accounts stay there. [Y/n] ",
    );
    const out = r.lines.join("\n");
    expect(out).toContain("Imported 1 account.");
    expect(out).not.toContain(CC_KEY);
    expect(r.asked.some((a) => a.hidden)).toBe(false);
    expect(await readFile(join(data, "gateway", "accounts.json"), "utf8")).toContain(CC_KEY);
  });

  it("declining the import falls back to pasting a key", async () => {
    await makeCcflare();
    const r = await fix(["y", "n", "", "n"]);
    expect(r.asked.some((a) => a.question.startsWith("Paste an Anthropic API key"))).toBe(true);
  });

  it("asks about keeping better-ccflare only when it was set before; n removes its address", async () => {
    await svc().updateSettings({ owlish: { url: "http://127.0.0.1:9" } } as never);
    // owlish is set, so the mode is better-ccflare: the pool is switched in Settings, here the legacy flow runs.
    const legacy = await fix(["n", "n"]);
    expect(legacy.asked.some((a) => a.question.startsWith("Keep better-ccflare"))).toBe(false);

    await svc().updateSettings({ gateway: { mode: "internal" } } as never);
    const keep = await fix(["", "", "n"]);
    expect(
      keep.asked.some((a) => a.question.startsWith("Keep better-ccflare for your subscription")),
    ).toBe(true);
    expect((await svc().loadSettings()).owlish?.url).toBe("http://127.0.0.1:9");

    const drop = await fix(["", "n", "n"]);
    expect(drop.asked.some((a) => a.question.startsWith("Keep better-ccflare"))).toBe(true);
    expect((await svc().loadSettings()).owlish).toBeUndefined();
  });

  it("--yes never imports or asks for a key", async () => {
    await makeCcflare();
    const t = terminal([]);
    await doctorCommand(["--fix", "--yes", "-d", data], {
      defaultRoot: () => data,
      service: () => svc(),
      io: t.io,
    });
    expect(t.asked).toEqual([]);
    expect((await svc().loadSettings()).gateway).toBeUndefined();
  });
});
