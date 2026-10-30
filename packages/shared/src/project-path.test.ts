import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECTS_ROOT,
  expandHome,
  isInsidePath,
  resolveProjectsRoot,
  resolveUnbornPath,
} from "./project-path.js";

let base: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "boof-project-path-")));
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe("projects root", () => {
  it("defaults to ~/boof-projects and expands ~", () => {
    expect(DEFAULT_PROJECTS_ROOT).toBe("~/boof-projects");
    expect(resolveProjectsRoot({})).toBe(join(homedir(), "boof-projects"));
    expect(resolveProjectsRoot({ projectsRoot: "~/code" })).toBe(join(homedir(), "code"));
    expect(resolveProjectsRoot({ projectsRoot: "/srv/p" })).toBe("/srv/p");
    expect(resolveProjectsRoot({ projectsRoot: "rel" })).toBe(join(homedir(), "rel"));
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("/x/~")).toBe("/x/~");
  });
});

describe("resolveUnbornPath", () => {
  it("returns the realpath of an existing directory with exists: true", async () => {
    expect(await resolveUnbornPath(base)).toEqual({ real: base, exists: true });
  });
  it("keeps the missing tail under the deepest existing ancestor", async () => {
    expect(await resolveUnbornPath(join(base, "a", "b"))).toEqual({
      real: join(base, "a", "b"),
      exists: false,
    });
  });
  it("follows a symlinked ancestor and keeps the missing tail", async () => {
    await mkdir(join(base, "real"));
    await symlink(join(base, "real"), join(base, "link"));
    expect(await resolveUnbornPath(join(base, "link", "new"))).toEqual({
      real: join(base, "real", "new"),
      exists: false,
    });
  });
  it("normalises .. before walking", async () => {
    expect((await resolveUnbornPath(join(base, "a", "..", "b"))).real).toBe(join(base, "b"));
  });
  it("reports exists: true for a file (the caller decides what that means)", async () => {
    await writeFile(join(base, "f"), "");
    expect((await resolveUnbornPath(join(base, "f"))).exists).toBe(true);
  });
  it("rejects a relative path", async () => {
    await expect(resolveUnbornPath("rel/x")).rejects.toThrow("absolute");
  });
});

describe("isInsidePath", () => {
  it("is true for the root itself and descendants, false for siblings and parents", () => {
    expect(isInsidePath("/a/b", "/a/b")).toBe(true);
    expect(isInsidePath("/a/b", "/a/b/c")).toBe(true);
    expect(isInsidePath("/a/b", "/a/bc")).toBe(false);
    expect(isInsidePath("/a/b", "/a")).toBe(false);
  });
});
