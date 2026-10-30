import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const repo = resolve(__dirname, "..", "..", "..");
const script = join(repo, "scripts", "release-version.sh");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boof-release-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.3.0" }));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const version = (tag: string) => run("bash", [script, tag, join(dir, "package.json")]);

describe("release-version.sh", () => {
  it("maps a release tag to the app version and the prerelease flag", async () => {
    expect((await version("v0.3.0")).stdout).toBe(
      "BOOF_RUNNER_APP_VERSION=0.3.0\nRELEASE_PRERELEASE_FLAG=\n",
    );
    expect((await version("v0.3.0-beta.1")).stdout).toBe(
      "BOOF_RUNNER_APP_VERSION=0.3.0-beta.1\nRELEASE_PRERELEASE_FLAG=--prerelease\n",
    );
    expect((await version("0.3.0-rc1")).stdout).toContain("BOOF_RUNNER_APP_VERSION=0.3.0-rc1\n");
  });

  it("refuses a malformed tag or one that does not match package.json", async () => {
    await expect(version("v0.3")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("is not v<major>.<minor>.<patch>"),
    });
    await expect(version("v0.4.0")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("tag v0.4.0 does not match package.json version 0.3.0"),
    });
    await expect(version("v0.4.0-beta")).rejects.toMatchObject({ code: 1 });
  });

  it("release.yml sources the version script and has no hard-coded --prerelease", async () => {
    const yml = await readFile(join(repo, ".github", "workflows", "release.yml"), "utf8");
    expect(yml).toContain('bash scripts/release-version.sh "$TAG" >> "$GITHUB_ENV"');
    expect(yml).toContain("$RELEASE_PRERELEASE_FLAG");
    expect(yml).not.toMatch(/--prerelease/);
    // The build step runs after the version step, so BOOF_RUNNER_APP_VERSION is in its env.
    expect(yml.indexOf("release-version.sh")).toBeLessThan(yml.indexOf("Build installers"));
  });

  it("stage-app no longer invents a -beta suffix", async () => {
    const src = await readFile(
      join(repo, "packages", "desktop", "scripts", "stage-app.mjs"),
      "utf8",
    );
    expect(src).not.toContain("-beta");
    expect(src).toContain("process.env.BOOF_RUNNER_APP_VERSION ?? baseVersion");
  });
});
