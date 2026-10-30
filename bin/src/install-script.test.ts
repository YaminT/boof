import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const repo = resolve(__dirname, "..", "..");
const script = join(repo, "scripts", "install-or-update-boof-runner.sh");
/**
 * Source the script's functions and run `body` with the given args as $1, $2, ...
 * The script path goes through an env var and $0 is a placeholder: the script's
 * `BASH_SOURCE[0] == $0` guard must see a sourced script, not a direct run.
 */
const fn = async (body: string, ...args: string[]) => {
  try {
    const r = await run("bash", ["-c", `source "$BOOF_SCRIPT"; ${body}`, "fn", ...args], {
      env: { ...process.env, BOOF_SCRIPT: script },
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout: string; stderr: string };
    return { code: err.code ?? 1, stdout: err.stdout, stderr: err.stderr };
  }
};

let dir: string;
beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), "boof-install-"))));
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("install script", () => {
  it("can be sourced without running main", async () => {
    const r = await fn("echo sourced");
    expect(r).toMatchObject({ code: 0, stdout: "sourced\n" });
  });

  it("reads the Node floor from package.json and compares major.minor.patch", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ engines: { node: ">=22.22" } }));
    expect((await fn('node_floor "$1"', dir)).stdout).toBe(">=22.22\n");
    const ok = async (v: string, range = ">=22.22") =>
      (await fn('node_version_ok "$1" "$2"', v, range)).code === 0;
    expect(await ok("v20.19.0")).toBe(false);
    expect(await ok("22.21.9")).toBe(false);
    expect(await ok("v22.22.0")).toBe(true);
    expect(await ok("22.22.1")).toBe(true);
    expect(await ok("v23.0.0")).toBe(true);
    expect(await ok("v22.23.4", ">=22.23.4")).toBe(true);
    expect(await ok("v22.23.3", ">=22.23.4")).toBe(false);
  });

  it("the floor in package.json is what the docs and the script promise", async () => {
    const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
    expect(pkg.engines.node).toBe(">=22.22");
    const text = await readFile(script, "utf8");
    expect(text).not.toMatch(/-ge 20/);
    expect(text).toContain('DEFAULT_REPO="https://github.com/YaminT/boof.git"');
  });
});
