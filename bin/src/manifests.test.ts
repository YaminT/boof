import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(__dirname, "..", "..");
const read = async (rel: string) =>
  JSON.parse(await readFile(join(repo, rel, "package.json"), "utf8"));

/** Workspace directories from the root package.json `workspaces`; `dir/*` globs are resolved by reading the directory. */
async function workspaceDirs(): Promise<string[]> {
  const root = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  const dirs: string[] = [];
  for (const pattern of root.workspaces as string[]) {
    if (pattern.endsWith("/*")) {
      const base = pattern.slice(0, -2);
      for (const entry of await readdir(join(repo, base), { withFileTypes: true })) {
        const rel = join(base, entry.name);
        if (entry.isDirectory() && existsSync(join(repo, rel, "package.json"))) dirs.push(rel);
      }
    } else {
      dirs.push(pattern);
    }
  }
  expect(dirs.length, "root workspaces resolve to no directories").toBeGreaterThan(0);
  return dirs.sort();
}

describe("workspace manifests", () => {
  it("every @boof-runner/* dependency names a real workspace", async () => {
    const manifests = await workspaceDirs();
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
    const manifests = await workspaceDirs();
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
