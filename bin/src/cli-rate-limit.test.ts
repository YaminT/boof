import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLI_RATE_WINDOW_MS,
  SettingsStore,
  cliRateLimitFile,
  conciergeSettings,
  execCommand,
  setCliRateNowForTests,
} from "@boof/heart";
import { TaskService } from "@boof/heart-server";
import { MockTool, ToolRegistry } from "@boof/runner";
import type { ConciergeAgent } from "@boof/heart";
import { scriptedAgent } from "../../packages/heart-server/src/concierge/fake-agent.js";
import { main } from "./boof-runner.js";

const devAgent = () => {
  (globalThis as { __boofDevConcierge?: ConciergeAgent }).__boofDevConcierge = scriptedAgent([
    { text: "ok" },
  ]);
};

const clearDevAgent = () => {
  delete (globalThis as { __boofDevConcierge?: ConciergeAgent }).__boofDevConcierge;
};

async function scaffold(limit: number): Promise<{ base: string; root: string }> {
  const base = await mkdtemp(join(tmpdir(), "boof-cli-rate-"));
  const root = join(base, "data");
  const repo = join(base, "repo");
  await mkdir(repo, { recursive: true });
  await execCommand("git", ["init", "-q"], { cwd: repo });
  const services = new TaskService(root, new ToolRegistry([new MockTool()]));
  await services.projects.create({ workingDirectory: repo, id: "demo" });
  const store = new SettingsStore(root);
  const settings = await store.load();
  await store.save({
    ...settings,
    concierge: { ...conciergeSettings(settings), messagesPerMinute: limit },
  });
  return { base, root };
}

async function ask(root: string): Promise<{ code: number; err: string }> {
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation((line) => {
    err.push(String(line));
  });
  process.exitCode = undefined;
  try {
    await main(["concierge", "ask", "--project", "demo", "--text", "hello", "--json", "-d", root]);
    return { code: process.exitCode ?? 0, err: err.join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = undefined;
  }
}

describe("CLI assistant rate limit", () => {
  const roots: string[] = [];
  const children: ChildProcess[] = [];

  afterEach(async () => {
    clearDevAgent();
    setCliRateNowForTests(undefined);
    for (const child of children.splice(0)) child.kill("SIGKILL");
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("limits the CLI entry after N calls inside one window", async () => {
    const limit = 2;
    const now = 1_800_000_000_000;
    const { base, root } = await scaffold(limit);
    roots.push(base);
    devAgent();
    setCliRateNowForTests(() => now);

    const first = await ask(root);
    expect(first.code).toBe(0);
    if (process.platform !== "win32") {
      expect((await stat(cliRateLimitFile(root))).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "ratelimit"))).mode & 0o777).toBe(0o700);
    }
    expect((await ask(root)).code).toBe(0);
    const blocked = await ask(root);
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain("rate_limited");
    expect(blocked.err).toContain("retryAfter");
  });

  it("treats a corrupt file as empty and resets the window when the clock jumps backwards", async () => {
    const now = 1_800_000_000_000;
    const { base, root } = await scaffold(1);
    roots.push(base);
    devAgent();
    setCliRateNowForTests(() => now);
    expect((await ask(root)).code).toBe(0);
    expect((await ask(root)).err).toContain("rate_limited");

    await writeFile(cliRateLimitFile(root), "{not json", { mode: 0o600 });
    expect((await ask(root)).code).toBe(0);

    setCliRateNowForTests(() => now);
    expect((await ask(root)).err).toContain("rate_limited");
    setCliRateNowForTests(() => now - CLI_RATE_WINDOW_MS - 1);
    expect((await ask(root)).code).toBe(0);
  });

  it("does not let two processes take the last slot", async () => {
    const now = 1_800_000_000_000;
    const { base, root } = await scaffold(2);
    roots.push(base);
    devAgent();
    setCliRateNowForTests(() => now);
    expect((await ask(root)).code).toBe(0);

    const home = await mkdtemp(join(tmpdir(), "boof-cli-rate-home-"));
    roots.push(home);
    const race = join(root, "race");
    await mkdir(race, { recursive: true });
    const child = fileURLToPath(new URL("../test-support/cli-rate-child.mts", import.meta.url));
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, BOOF_RUNNER_DATA_ROOT: root };
    for (const key of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "BOOF_RUNNER_AGENT_OF",
    ]) {
      delete env[key];
    }

    const run = () =>
      new Promise<{ code: number; err: string }>((resolve, reject) => {
        const proc = spawn(process.execPath, ["--import", "tsx", child, root, String(now)], {
          cwd: repoRoot,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(proc);
        let err = "";
        proc.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
          err += chunk;
        });
        proc.once("error", reject);
        proc.once("exit", (code) => resolve({ code: code ?? 1, err }));
      });

    const first = run();
    const second = run();
    const deadline = Date.now() + 20_000;
    while ((await readdir(race)).filter((name) => name.startsWith("ready-")).length < 2) {
      if (Date.now() > deadline) throw new Error("children did not reach the barrier");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await writeFile(join(race, "go"), "");
    while ((await readdir(race)).filter((name) => name.startsWith("gate-")).length < 2) {
      if (Date.now() > deadline)
        throw new Error(`children did not reach the limiter: ${(await readdir(race)).join(",")}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    while ((await readdir(race)).filter((name) => name.startsWith("entered-")).length < 1) {
      if (Date.now() > deadline) throw new Error("no child entered the lock");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await readdir(race)).filter((name) => name.startsWith("entered-"))).toHaveLength(1);
    await writeFile(join(race, "release"), "");

    const results = await Promise.all([first, second]);
    const limited = results.filter((result) => result.err.includes("rate_limited"));
    const ok = results.filter((result) => result.code === 0);
    expect(ok).toHaveLength(1);
    expect(limited).toHaveLength(1);
    expect(
      results.find((result) => result.code !== 0 && !result.err.includes("rate_limited")),
    ).toBeUndefined();
  }, 40_000);
});
