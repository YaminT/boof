import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(__dirname, "..", "..");
const manifests = [
  "bin",
  "packages/api",
  "packages/desktop",
  "packages/mcp",
  "packages/runner",
  "packages/shared",
  "packages/web",
];
const read = async (rel: string) =>
  JSON.parse(await readFile(join(repo, rel, "package.json"), "utf8"));

describe("workspace manifests", () => {
  it("every @boof-runner/* dependency names a real workspace", async () => {
    const names = new Set<string>();
    for (const rel of manifests) names.add((await read(rel)).name);
    let checked = 0;
    for (const rel of manifests) {
      const pkg = await read(rel);
      for (const section of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        for (const name of Object.keys(pkg[section] ?? {})) {
          if (!name.startsWith("@boof-runner/")) continue;
          checked += 1;
          expect(names.has(name), `${rel}: ${name} is not a workspace (${[...names]})`).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("no workspace manifest uses the workspace: protocol and every CLI external is a root dependency", async () => {
    for (const rel of manifests) {
      const pkg = await read(rel);
      for (const section of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
          expect(String(spec), `${rel}: ${name}`).not.toMatch(/^workspace:/);
          if (name.startsWith("@boof-runner/")) expect(spec, `${rel}: ${name}`).toBe("*");
        }
      }
    }
    const root = await read(".");
    const bin = await read("bin");
    const tsup = await readFile(join(repo, "bin", "tsup.config.ts"), "utf8");
    const list = /\bexternal: \[([^\]]*)\]/.exec(tsup);
    expect(list, "external list in bin/tsup.config.ts").not.toBeNull();
    const externals = [...list![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(externals.length).toBeGreaterThan(0);
    for (const ext of externals) {
      expect(root.dependencies?.[ext as string], `root dependency ${String(ext)}`).toBe(
        bin.dependencies[ext as string],
      );
    }
  });

  it("package-lock.json is ignored: bun.lock is the lockfile", async () => {
    const ignore = await readFile(join(repo, ".gitignore"), "utf8");
    expect(ignore.split("\n")).toContain("package-lock.json");
  });
});
