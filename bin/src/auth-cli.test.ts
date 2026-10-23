import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "@boof-runner/shared";
import { authCommand } from "./auth-cli.js";

let root: string;
let out: string[];
let errs: string[];

const run = (...argv: string[]) =>
  authCommand(
    argv,
    () => root,
    (l) => out.push(l),
    (l) => errs.push(l),
  );

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-runner-authcli-"));
  out = [];
  errs = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("boof-runner auth", () => {
  it("add prints the key once; list, rotate and revoke manage it without ever reprinting it", async () => {
    expect(
      await run(
        "add",
        "--name",
        "CI Bot",
        "--scopes",
        "tasks:read,tasks:write",
        "--expires",
        "30d",
      ),
    ).toBe(0);
    const key = out.map((l) => l.trim()).find((l) => l.startsWith("boof_ci-bot_"))!;
    expect(key).toBeTruthy();
    expect((await new AuthStore(root).verify(key)).ok).toBe(true);
    expect(await readFile(join(root, "auth", "clients.json"), "utf8")).not.toContain(key);

    out.length = 0;
    expect(await run("list")).toBe(0);
    const listing = out.join("\n");
    expect(listing).toContain("ci-bot");
    expect(listing).toContain("review");
    expect(listing).not.toContain(key);

    out.length = 0;
    expect(await run("rotate", "ci-bot")).toBe(0);
    const rotated = out.map((l) => l.trim()).find((l) => l.startsWith("boof_ci-bot_"))!;
    expect(rotated).not.toBe(key);
    expect((await new AuthStore(root).verify(key)).ok).toBe(false);

    expect(await run("revoke", "ci-bot")).toBe(0);
    expect(await run("rotate", "ci-bot")).toBe(1);
    expect(await run("revoke", "ghost")).toBe(1);
  });

  it("validates input", async () => {
    expect(await run("add", "--scopes", "tasks:read")).toBe(1);
    expect(await run("add", "--name", "x")).toBe(1);
    expect(await run("add", "--name", "x", "--scopes", "root")).toBe(1);
    expect(await run("add", "--name", "x", "--scopes", "tasks:read", "--trust", "maybe")).toBe(1);
    expect(await run("add", "--name", "x", "--scopes", "tasks:read", "--expires", "soon")).toBe(1);
    expect(await run("add", "--name", "x", "--scopes", "tasks:read", "--bogus")).toBe(1);
    expect(await run("frobnicate")).toBe(1);
    expect(await new AuthStore(root).list()).toEqual([]);
  });

  it("supports trusted clients restricted to projects", async () => {
    expect(
      await run(
        "add",
        "--name",
        "T",
        "--scopes",
        "admin",
        "--trust",
        "trusted",
        "--projects",
        "a,b",
      ),
    ).toBe(0);
    const [c] = await new AuthStore(root).list();
    expect(c).toMatchObject({ trust: "trusted", projects: ["a", "b"], scopes: ["admin"] });
  });
});
