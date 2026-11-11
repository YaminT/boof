import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  execCommand,
  newTask,
  ProjectStore,
  SettingsStore,
  TaskStore,
  defaultSettings,
  type TaskFrontmatter,
} from "@boof/heart";
import { agentMarkerFor } from "../agent-marker.js";
import { RunnerEngine } from "../engine.js";
import { mockState, resetMock } from "../tools/mock.js";
import { linuxSandboxSuite, makeFixture, sandboxed } from "./accept-support.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const refusal =
  "boof-runner: refused. This process was started by a task agent of this boof data root, and task agents get no access to boof. Run boof-runner yourself, outside the agent.";

linuxSandboxSuite("sandbox acceptance: mock task and layer 1", () => {
  it("A17 finishes plan, develop and review under enforce, with the diff and leftovers commit", async () => {
    const saved = new Map<string, string | undefined>();
    const remember = (key: string) => {
      if (!saved.has(key)) saved.set(key, process.env[key]);
    };
    const base = await mkdtemp(join(tmpdir(), "boof-i1f-a17-"));
    const home = join(base, "home");
    const state = join(base, "state");
    const dataRoot = join(base, "data");
    const workDir = await realpath(await mkdtemp(join(tmpdir(), "boof-i1f-a17-work-")));
    remember("HOME");
    remember("XDG_STATE_HOME");
    remember("BOOF_SANDBOX_HELPER");
    remember("BOOF_SANDBOX_FAKE_ABI");
    process.env.HOME = home;
    process.env.XDG_STATE_HOME = state;
    delete process.env.BOOF_SANDBOX_HELPER;
    delete process.env.BOOF_SANDBOX_FAKE_ABI;
    await mkdir(home, { recursive: true });
    await mkdir(state, { recursive: true });
    resetMock();
    try {
      const git = (args: string[], cwd = workDir) =>
        execCommand("git", args, { launch: { kind: "direct" }, cwd, timeoutMs: 15_000 });
      const init = await git(["init", "-b", "main"]);
      if (init.code !== 0) throw new Error(init.stderr);
      await git(["config", "user.email", "t@e.com"]);
      await git(["config", "user.name", "T"]);
      await git(["config", "commit.gpgsign", "false"]);
      await writeFile(join(workDir, "README.md"), "# work\n");
      await git(["add", "."]);
      await git(["commit", "-m", "init"]);

      await new SettingsStore(dataRoot).save({
        ...defaultSettings(),
        runner: {
          enabled: true,
          concurrency: 1,
          sandbox: { mode: "enforce", readPaths: [], writePaths: [], denyTcpPorts: [] },
        },
      });
      const project = await new ProjectStore(dataRoot).create({
        workingDirectory: workDir,
        id: "default",
      });
      const store = new TaskStore(new ProjectStore(dataRoot).dir(project.id));
      const engine = new RunnerEngine({ root: dataRoot, pollIntervalMs: 10 });
      mockState.onRun = async (opts) => {
        if (opts.role !== "developer") return;
        if (opts.launch?.kind !== "sandbox") {
          throw new Error("developer step was not a sandbox launch");
        }
        const script = [
          "set -e",
          "printf 'feature\\n' > feature.txt",
          "git add -- feature.txt",
          "git -c commit.gpgsign=false commit -m 'sandbox feature'",
          "printf 'left\\n' > left.txt",
        ].join("\n");
        const ran = await execCommand("/bin/sh", ["-c", script], {
          cwd: opts.cwd,
          launch: opts.launch,
          env: { PATH: "/usr/bin:/bin", LANG: "C" },
          timeoutMs: 30_000,
        });
        if (ran.code !== 0) {
          throw new Error(`sandboxed developer failed: ${ran.stderr || ran.stdout}`);
        }
      };
      await store.create(newTask(fm(), "Build the feature."));
      const result = await engine.tick();
      expect(result.kind).toBe("ran");
      if (result.kind === "ran") expect(result.outcome.kind).toBe("done");
      const done = await store.get("t1");
      expect(done?.frontmatter.status).toBe("done");
      const log = done?.body.log ?? "";
      expect(log).toContain("### Planner");
      expect(log).toContain("### Developer");
      expect(log).toContain("### Reviewer");
      expect(log).toContain("APPROVE");
      expect(mockState.calls).toEqual(["planner", "planner", "developer", "reviewer"]);
      expect((await git(["show", "boof-runner/t1:feature.txt"])).stdout).toContain("feature");
      expect((await git(["show", "boof-runner/t1:left.txt"])).code).not.toBe(0);
      const side = (await git(["rev-parse", "boof-runner/t1--leftovers"])).stdout.trim();
      expect(side).toMatch(/^[0-9a-f]{40}$/);
      expect((await git(["show", "boof-runner/t1--leftovers:left.txt"])).stdout).toContain("left");
      expect(log).toContain(`Leftovers committed to boof-runner/t1--leftovers at ${side}`);
      const diff = await git(["diff", "main...boof-runner/t1"]);
      expect(diff.code).toBe(0);
      expect(diff.stdout).toContain("feature.txt");
      expect(diff.stdout).not.toContain("left.txt");
    } finally {
      resetMock();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
      await rm(base, { recursive: true, force: true });
    }
  }, 180_000);

  it("A18 keeps the layer-1 port denial and the marker refusal under enforce", async () => {
    const curl = existsSync("/usr/bin/curl") ? "/usr/bin/curl" : "";
    expect(curl, "curl is required for the layer-1 port check").not.toBe("");
    const base = await mkdtemp(join(tmpdir(), "boof-i1f-a18-"));
    const dataRoot = join(base, "data");
    const home = join(base, "home");
    await mkdir(dataRoot);
    await mkdir(home);
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(repoRoot, "bin/src/boof-runner.ts"),
        "serve",
        "-d",
        dataRoot,
        "-p",
        "0",
        "--no-runner",
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: home,
        },
      },
    );
    let text = "";
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`serve did not start:\n${text}`)), 45_000);
        child.stdout.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          const match = /API:\s+http:\/\/[^:\s]+:(\d+)\/api/.exec(text);
          if (match?.[1]) {
            clearTimeout(timer);
            resolve(Number(match[1]));
          }
        });
        child.on("exit", () => reject(new Error(`serve exited early:\n${text}`)));
      });
      child.removeAllListeners("exit");
      const fx = await makeFixture({ readPaths: [repoRoot] });
      fx.ctx.serverPort = port;
      const curlRun = await sandboxed(
        fx,
        curl,
        [
          "-sS",
          "-m",
          "2",
          "-o",
          `${fx.temp}/body`,
          "-w",
          "%{http_code}",
          `http://127.0.0.1:${port}/api/v1/projects`,
        ],
        { timeoutMs: 15_000 },
      );
      expect(curlRun.code, `${curlRun.stderr}\n${curlRun.stdout}`).not.toBe(0);
      expect(curlRun.stdout).not.toContain("200");
      const body = await readFile(join(fx.temp, "body"), "utf8").catch(() => "");
      expect(body).not.toContain("browser_session_required");
      expect(body).not.toContain('"projects"');
      const marker = await sandboxed(
        fx,
        process.execPath,
        [
          "--import",
          "tsx",
          join(repoRoot, "bin/src/boof-runner.ts"),
          "auth",
          "clients",
          "create",
          "--name",
          "pwn",
          "--scopes",
          "admin",
          "-d",
          dataRoot,
        ],
        {
          cwd: repoRoot,
          timeoutMs: 30_000,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            BOOF_RUNNER_AGENT_OF: agentMarkerFor(dataRoot),
          },
        },
      );
      expect(marker.code, `${marker.stderr}\n${marker.stdout}`).toBe(3);
      expect(marker.stderr).toContain(refusal);
      expect(marker.stdout).not.toContain("client");
    } finally {
      child.kill("SIGTERM");
      await rm(base, { recursive: true, force: true });
    }
  }, 120_000);
});

function fm(): TaskFrontmatter {
  return {
    id: "t1",
    title: "T1",
    status: "pending",
    priority: 50,
    skip: false,
    labels: [],
    command: null,
    attachments: [],
    questions: "none",
    tools: {
      planner: { tool: "mock", model: "mock-default" },
      developer: { tool: "mock", model: "mock-default" },
      reviewer: { tool: "mock", model: "mock-default" },
    },
    created: "2026-06-04T10:00:00.000Z",
    updated: "2026-06-04T10:00:00.000Z",
  };
}
