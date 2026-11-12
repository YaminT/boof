import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexTool } from "./codex.js";

const KEYS = ["HOME", "USERPROFILE", "PATH", "BOOF_RUNNER_CODEX_BIN"] as const;
let dir: string;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boof-offpath-"));
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
});
afterEach(async () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// The fake program is a POSIX shell script.
describe.skipIf(process.platform === "win32")("a harness found off PATH", () => {
  it("is spawned by the path the install check found, not by its bare name", async () => {
    const home = join(dir, "home");
    const bin = join(home, ".local", "bin");
    await mkdir(bin, { recursive: true });
    const marker = join(dir, "ran.log");
    await writeFile(
      join(bin, "offpathcodex"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${marker}"\n[ "$1" = "--version" ] && echo "fake 1.0.0"\ncat >/dev/null\nexit 0\n`,
    );
    await chmod(join(bin, "offpathcodex"), 0o755);
    const empty = join(dir, "empty");
    await mkdir(empty);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PATH = empty;
    process.env.BOOF_RUNNER_CODEX_BIN = "offpathcodex";

    const tool = new CodexTool();
    const install = await tool.installed();
    expect(install).toMatchObject({ installed: true, foundOffPath: join(bin, "offpathcodex") });

    await tool
      .run({
        prompt: "hello",
        systemPrompt: "sys",
        model: "m",
        cwd: dir,
        role: "developer",
      } as never)
      .catch(() => undefined);
    const calls = (await readFile(marker, "utf8")).trim().split("\n");
    // `--version` from the check, then the real `exec` run: the spawn found the file.
    expect(calls.some((c) => c.startsWith("exec --json"))).toBe(true);

    // A later check still reports it as off PATH (it looks up the name, not the saved path).
    expect((await tool.installed()).foundOffPath).toBe(join(bin, "offpathcodex"));
  });
});
