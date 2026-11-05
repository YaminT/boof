import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getOp, registry } from "@boof/heart-server";
import {
  HAND_WRITTEN_COMMANDS,
  RESERVED_FLAGS,
  commandPath,
  isOpArea,
  matchOpCommand,
  parseOpArgs,
} from "./ops-cli.js";

const op = (name: string) => {
  const o = getOp(name);
  if (!o) throw new Error(`no operation ${name}`);
  return o;
};
const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boof-opscli-"));
});
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe("command paths", () => {
  it("turns an operation name into words", () => {
    expect(commandPath(op("tasks.create"))).toEqual(["tasks", "create"]);
    expect(commandPath(op("plans.replaceGoals"))).toEqual(["plans", "replace-goals"]);
    expect(commandPath(op("tasks.liveLog"))).toEqual(["tasks", "live-log"]);
    expect(commandPath(op("auth.clients.revoke"))).toEqual(["auth", "clients", "revoke"]);
    expect(commandPath(op("tasks.attachments.add"))).toEqual(["tasks", "attachments", "add"]);
  });

  it("every operation has a unique command path", () => {
    expect(new Set(registry.map((o) => commandPath(o).join(" "))).size).toBe(registry.length);
  });

  it("matches the longest leading run of words that names an operation", () => {
    const m = matchOpCommand(["tasks", "create", "--title", "x"]);
    expect(m?.op.name).toBe("tasks.create");
    expect(m?.rest).toEqual(["--title", "x"]);
    expect(matchOpCommand(["auth", "clients", "list"])?.op.name).toBe("auth.clients.list");
    expect(matchOpCommand(["auth", "add"])).toBeUndefined();
    expect(matchOpCommand(["tasks"])).toBeUndefined();
    expect(matchOpCommand(["task", "list"])).toBeUndefined();
  });

  it("knows the areas", () => {
    expect(isOpArea("tasks")).toBe(true);
    expect(isOpArea("auth")).toBe(true);
    expect(isOpArea("task")).toBe(false);
    expect(isOpArea("ops")).toBe(false);
  });

  it("no generated command shadows a hand-written one", () => {
    for (const o of registry) {
      const path = commandPath(o);
      const hand = HAND_WRITTEN_COMMANDS[path[0]!];
      if (hand) expect(hand, o.name).not.toContain(path[1]);
    }
  });

  it("no input field takes a reserved flag name", () => {
    for (const o of registry) {
      const keys = Object.keys((o.input as { shape: object }).shape).map(kebab);
      for (const k of keys) expect(RESERVED_FLAGS, `${o.name} --${k}`).not.toContain(k);
    }
  });
});

describe("parseOpArgs", () => {
  it("coerces strings, numbers and string lists", () => {
    const r = parseOpArgs(
      op("tasks.create"),
      ["--project", "shop", "--title", "Fix X", "--priority", "2", "--labels", "a,b"],
      dir,
    );
    expect(r.input).toEqual({ projectId: "shop", title: "Fix X", priority: 2, labels: ["a", "b"] });
  });

  it("a repeated list flag appends and a JSON array is parsed", () => {
    expect(
      parseOpArgs(op("tasks.create"), ["--labels", "a", "--labels", "b"], dir).input.labels,
    ).toEqual(["a", "b"]);
    expect(parseOpArgs(op("tasks.create"), ["--labels", '["x","y"]'], dir).input.labels).toEqual([
      "x",
      "y",
    ]);
  });

  it("booleans: bare, =value and --no-", () => {
    const sync = op("plans.sync");
    const base = ["--project-id", "shop", "--plan-id", "q4"];
    expect(parseOpArgs(sync, [...base, "--dry-run"], dir).input.dryRun).toBe(true);
    expect(parseOpArgs(sync, [...base, "--no-dry-run"], dir).input.dryRun).toBe(false);
    expect(parseOpArgs(sync, [...base, "--dry-run=false"], dir).input.dryRun).toBe(false);
    expect(parseOpArgs(sync, [...base, "--dry-run=1"], dir).input.dryRun).toBe(true);
  });

  it("a nullable field takes the literal null", () => {
    expect(parseOpArgs(op("tasks.move"), ["--parent-id", "null"], dir).input.parentId).toBeNull();
    expect(parseOpArgs(op("tasks.move"), ["--parent-id", "p"], dir).input.parentId).toBe("p");
  });

  it("JSON fields read text or @file; bad JSON is a usage error", async () => {
    await writeFile(join(dir, "goals.json"), JSON.stringify([{ id: "a" }]));
    expect(parseOpArgs(op("plans.create"), ["--goals", "@goals.json"], dir).input.goals).toEqual([
      { id: "a" },
    ]);
    expect(parseOpArgs(op("plans.create"), ["--goals", '[{"id":"b"}]'], dir).input.goals).toEqual([
      { id: "b" },
    ]);
    expect(() => parseOpArgs(op("plans.create"), ["--goals", "{bad"], dir)).toThrow(
      /--goals: not valid JSON/,
    );
  });

  it("refuses write-only secrets as flags and accepts them in --input", () => {
    expect(() =>
      parseOpArgs(
        op("projects.update"),
        ["--project-id", "p", "--anthropic-api-key", "secret"],
        dir,
      ),
    ).toThrow(/write-only.*--input @file/);
    expect(
      parseOpArgs(
        op("projects.update"),
        ["--input", '{"projectId":"p","anthropicApiKey":"secret"}'],
        dir,
      ).input.anthropicApiKey,
    ).toBe("secret");
    expect(() => parseOpArgs(op("settings.update"), ["--owlish-api-key", "secret"], dir)).toThrow(
      /write-only/,
    );
  });

  it("--input gives the whole object and flags override its keys", () => {
    const r = parseOpArgs(
      op("tasks.create"),
      ["--input", '{"title":"A","prompt":"p"}', "--title", "B"],
      dir,
    );
    expect(r.input).toMatchObject({ title: "B", prompt: "p" });
  });

  it("a value that looks like a flag, or holds =, is still the value", () => {
    expect(parseOpArgs(op("tasks.create"), ["--title", "-x"], dir).input.title).toBe("-x");
    expect(parseOpArgs(op("tasks.create"), ["--title", "--force"], dir).input.title).toBe(
      "--force",
    );
    expect(parseOpArgs(op("tasks.create"), ["--prompt=a=b=c"], dir).input.prompt).toBe("a=b=c");
  });

  it("a non-numeric number is left for the schema to reject", () => {
    expect(parseOpArgs(op("tasks.create"), ["--priority", "abc"], dir).input.priority).toBe("abc");
    expect(parseOpArgs(op("tasks.create"), ["--priority", ""], dir).input.priority).toBe("");
  });

  it("refuses an unknown option and a stray word", () => {
    expect(() => parseOpArgs(op("tasks.create"), ["--nope"], dir)).toThrow(/unknown option --nope/);
    expect(() => parseOpArgs(op("tasks.create"), ["extra"], dir)).toThrow(/unexpected argument/);
    expect(() => parseOpArgs(op("tasks.create"), ["--title"], dir)).toThrow(
      /--title needs a value/,
    );
  });

  it("an attachment file is a path, typed by its extension", async () => {
    const bytes = Buffer.from([1, 2, 3]);
    await writeFile(join(dir, "a.png"), bytes);
    const f = parseOpArgs(op("tasks.attachments.add"), ["--file", "a.png"], dir).input.file as {
      name: string;
      type: string;
      bytes: Uint8Array;
    };
    expect(f.name).toBe("a.png");
    expect(f.type).toBe("image/png");
    expect(Buffer.from(f.bytes).equals(bytes)).toBe(true);
    await writeFile(join(dir, "x.bin"), bytes);
    expect(
      (
        parseOpArgs(op("tasks.attachments.add"), ["--file", "x.bin"], dir).input.file as {
          type: string;
        }
      ).type,
    ).toBe("application/octet-stream");
  });

  it("the CLI's own flags are not input", () => {
    const r = parseOpArgs(
      op("tasks.list"),
      ["--json", "-d", "/data", "--client", "c", "--out", "f", "-h", "--project", "p"],
      dir,
    );
    expect(r).toMatchObject({ json: true, help: true, data: "/data", client: "c", out: "f" });
    expect(r.input).toEqual({ projectId: "p" });
  });
});
