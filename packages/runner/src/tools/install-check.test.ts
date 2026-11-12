import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findExecutable, knownInstallDirs } from "@boof/heart";
import type { InstallResult } from "@boof/heart";
import { checkInstalled, cleanVersion } from "./install-check.js";
import { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boof-install-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** A fake program that records every argument it is given and prints a version for --version. */
async function fakeBin(where: string, name: string, body?: string): Promise<string> {
  await mkdir(where, { recursive: true });
  const path = join(where, name);
  await writeFile(
    path,
    body ??
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/args.log"\n[ "$*" = "--version" ] || exit 9\necho "fake 1.2.3"\n`,
  );
  await chmod(path, 0o755);
  return path;
}

// The fake programs are POSIX shell scripts and mode bits; Windows is covered by the injected-platform test.
describe.skipIf(process.platform === "win32")("checkInstalled", () => {
  it("finds a program on PATH, asks only for --version and never sends a prompt", async () => {
    const bin = join(dir, "bin");
    await fakeBin(bin, "fakeagent");
    const res = await checkInstalled("fakeagent", {
      env: { PATH: bin },
      home: join(dir, "home"),
    });
    expect(res).toMatchObject({
      installed: true,
      version: "fake 1.2.3",
      path: join(bin, "fakeagent"),
    });
    expect(res.foundOffPath).toBeUndefined();
    expect((await readFile(join(dir, "args.log"), "utf8")).trim()).toBe("--version");
  });

  it("finds a program off PATH in a known install location", async () => {
    const home = join(dir, "home");
    const path = await fakeBin(join(home, ".local", "bin"), "fakeagent");
    const res = await checkInstalled("fakeagent", { env: { PATH: join(dir, "empty") }, home });
    expect(res.installed).toBe(true);
    expect(res.foundOffPath).toBe(path);
    expect(res.message).toContain("not on PATH");
  });

  it("reports a missing program", async () => {
    const res = await checkInstalled("fakeagent", {
      env: { PATH: join(dir, "empty") },
      home: join(dir, "home"),
    });
    expect(res).toMatchObject({ installed: false });
    expect(res.message).toContain("not found");
  });

  it("reports a program that exits non-zero for --version", async () => {
    const bin = join(dir, "bin");
    await fakeBin(bin, "fakeagent", "#!/bin/sh\nexit 3\n");
    const res = await checkInstalled("fakeagent", { env: { PATH: bin }, home: dir });
    expect(res.installed).toBe(false);
    expect(res.message).toContain("exited 3");
  });

  it("treats a program that hangs as not installed", async () => {
    const bin = join(dir, "bin");
    await fakeBin(bin, "fakeagent", "#!/bin/sh\nexec sleep 30\n");
    const res = await checkInstalled("fakeagent", {
      env: { PATH: bin },
      home: dir,
      timeoutMs: 300,
    });
    expect(res.installed).toBe(false);
    expect(res.message).toContain("did not answer");
  });

  it("strips colour codes from the version", () => {
    expect(cleanVersion("\u001b[1m\u001b[32m2.0.1 (Fake)\u001b[0m\n")).toBe("2.0.1 (Fake)");
    expect(cleanVersion("\n  \n")).toBeUndefined();
  });
});

describe("findExecutable", () => {
  it.skipIf(process.platform === "win32")(
    "skips a non-executable file and a directory with the name",
    async () => {
      const bin = join(dir, "bin");
      await mkdir(join(bin, "dirname"), { recursive: true });
      await writeFile(join(bin, "plain"), "x");
      await chmod(join(bin, "plain"), 0o644);
      expect(await findExecutable("plain", { env: { PATH: bin }, home: dir })).toBeUndefined();
      expect(await findExecutable("dirname", { env: { PATH: bin }, home: dir })).toBeUndefined();
    },
  );

  it("tries PATHEXT on Windows (injected platform) and uses its known locations", async () => {
    const appdata = join(dir, "AppData");
    await fakeBin(join(appdata, "npm"), "codex.CMD", "@echo off");
    const res = await findExecutable("codex", {
      platform: "win32",
      env: { PATH: "", PATHEXT: ".EXE;.CMD", APPDATA: appdata },
      home: dir,
      extraDirs: [join(appdata, "npm")],
    });
    expect(res?.offPath).toBe(true);
    expect(res?.path.toLowerCase().endsWith("codex.cmd")).toBe(true);
  });

  it("lists the Windows and Unix install locations", () => {
    expect(knownInstallDirs({ platform: "linux", env: {}, home: "/h" })).toEqual(
      expect.arrayContaining([
        "/h/.local/bin",
        "/h/.claude/local",
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ]),
    );
    expect(
      knownInstallDirs({
        platform: "win32",
        env: { APPDATA: "C:\\A", LOCALAPPDATA: "C:\\L" },
        home: "C:\\H",
      }),
    ).toEqual(expect.arrayContaining(["C:\\A\\npm", "C:\\L\\Programs"]));
  });
});

function stubTool(id: string, calls: string[], result?: InstallResult): Tool {
  return {
    id,
    displayName: id,
    defaultModels: [],
    installed: async () => {
      calls.push(id);
      await new Promise((r) => setTimeout(r, 20));
      if (!result) throw new Error("boom");
      return result;
    },
    detect: async () => ({ status: "available", message: "" }),
    listModels: async () => [],
    run: async () => ({ output: "", report: "" }),
  };
}

describe("ToolRegistry.installedAll", () => {
  it("shares one in-flight check, caches by age and survives a throwing tool", async () => {
    const calls: string[] = [];
    const reg = new ToolRegistry([
      stubTool("a", calls, { installed: true, message: "ok" }),
      stubTool("b", calls),
    ]);
    const [x, y] = await Promise.all([reg.installedAll(), reg.installedAll()]);
    expect(calls).toEqual(["a", "b"]);
    expect(x).toBe(y);
    expect(x.a.installed).toBe(true);
    expect(x.b).toMatchObject({ installed: false, message: expect.stringContaining("boom") });
    expect(x.a.checkedAt).toBeTruthy();
    await reg.installedAll();
    expect(calls).toHaveLength(2);
    await reg.installedAll(0);
    expect(calls).toHaveLength(4);
  });
});
