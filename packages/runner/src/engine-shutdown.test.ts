import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  newTask,
  ExternalRunStore,
  TaskStore,
  taskControlDir,
  taskPidPath,
  taskStopRequestPath,
  workingAreaDir,
  type Project,
} from "@boof/heart";
import { RunnerEngine } from "./engine.js";
import { execCommand } from "@boof/heart";
import { currentBootIdentity, isAlive, writePidFile } from "@boof/heart";
import { ensureWorktree } from "./worktree.js";
import { ToolRunError } from "./tools/errors.js";
import { mockState } from "./tools/mock.js";
import { useEngineRig, exists, wtPath, fm, addProject } from "./engine-test-support.js";

let dataRoot: string;
let workDir: string;
let engine: RunnerEngine;
/** The project under test: `workDir` registered as project `default`. */
let project: Project;
let projectDir: string;
let store: TaskStore;

useEngineRig((rig) => {
  ({ dataRoot, workDir, engine, project, projectDir, store } = rig);
});

describe("RunnerEngine.shutdown (SIGTERM under systemd)", () => {
  // Stand-in agent is a POSIX shell script; Windows cannot exec it.
  it.skipIf(process.platform === "win32")(
    "stops the running task, kills the agent process group and leaves the task stopped (retryable)",
    async () => {
      await store.create(newTask(fm(), "Long job."));
      const pidFile = join(dataRoot, "agent.pid");
      let started!: () => void;
      const up = new Promise<void>((r) => (started = r));
      mockState.onRun = async (opts) => {
        // A stand-in agent: a shell that spawns a grandchild and waits for it.
        const watch = setInterval(() => {
          if (existsSync(pidFile)) {
            clearInterval(watch);
            started();
          }
        }, 20);
        const res = await execCommand("sh", ["-c", `sleep 300 & echo $! > "${pidFile}"; wait`], {
          cwd: opts.cwd,
          stopSignalPath: opts.stopSignalPath,
          stopPollMs: 25,
          launch: opts.launch ?? { kind: "direct" },
        });
        clearInterval(watch);
        throw new ToolRunError("mock", res.code, res.timedOut, res.stopped, "stopped", res.stderr);
      };
      const loop = engine.loop();
      await up;
      const grandchild = Number((await readFile(pidFile, "utf8")).trim());
      expect(() => process.kill(grandchild, 0)).not.toThrow();

      const result = await engine.shutdown(15000);
      expect(result).toEqual({ stopped: ["t1"], timedOut: false });
      await loop;

      const after = await store.get("t1");
      expect(after?.frontmatter.status).toBe("stopped");
      expect(after?.body.log).toContain("stopped by server shutdown");
      await new Promise((r) => setTimeout(r, 100));
      expect(() => process.kill(grandchild, 0)).toThrow(); // not orphaned
      // stopped -> pending is a legal transition, so the task can be retried after a restart.
      await store.transition("t1", "pending");
      expect((await store.get("t1"))?.frontmatter.status).toBe("pending");
    },
  );

  it("returns at once when nothing is running", async () => {
    expect(await engine.shutdown(1000)).toEqual({ stopped: [], timedOut: false });
  });

  afterEach(() => vi.restoreAllMocks());

  it("a shutdown that lands during selection starts nothing", async () => {
    await store.create(newTask(fm(), "Build it."));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let selecting!: () => void;
    const inSelect = new Promise<void>((r) => (selecting = r));
    const target = engine as unknown as { selectWithBudget: () => Promise<unknown> };
    const original = target.selectWithBudget.bind(engine);
    vi.spyOn(target, "selectWithBudget").mockImplementationOnce(async () => {
      selecting();
      await gate;
      return original();
    });
    const looping = engine.loop();
    await inSelect;
    const down = engine.shutdown(5000);
    release();
    expect(await down).toEqual({ stopped: [], timedOut: false });
    await looping;
    expect((await store.get("t1"))?.frontmatter.status).toBe("pending");
    expect(mockState.calls).toEqual([]);
    expect(await exists(taskStopRequestPath(projectDir, "t1"))).toBe(false);
  });

  it("a shutdown that lands while the task is still starting stops it", async () => {
    await store.create(newTask(fm(), "Build it."));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let starting!: () => void;
    const inStart = new Promise<void>((r) => (starting = r));
    const target = engine as unknown as { startTask: (...a: unknown[]) => Promise<unknown> };
    const original = target.startTask.bind(engine);
    vi.spyOn(target, "startTask").mockImplementationOnce(async (...a) => {
      starting();
      await gate;
      return original(...a);
    });
    const run = engine.tick(); // selected and registered as running, still pending on disk
    await inStart;
    const down = engine.shutdown(10_000);
    release();
    expect((await down).timedOut).toBe(false);
    await run;
    expect((await store.get("t1"))?.frontmatter.status).toBe("stopped");
    expect((await store.get("t1"))?.body.log).toContain("stopped by server shutdown");
  });

  it("asks a task that starts while it drains to stop as well", async () => {
    const b = await addProject("b");
    await store.create(newTask(fm({ id: "a1" }), "a"));
    await b.store.create(newTask(fm({ id: "b1" }), "b"));
    const gate = () => {
      let open!: () => void;
      const wait = new Promise<void>((r) => (open = r));
      return { wait, open };
    };
    const started = { a1: gate(), b1: gate() };
    const go = { a1: gate(), b1: gate() };
    mockState.onRun = async (opts) => {
      if (opts.role !== "planner") return;
      const id = basename(opts.cwd) as "a1" | "b1";
      started[id].open();
      await go[id].wait;
    };
    const runA = engine.tick(); // a1 runs, its planner held open
    await started.a1.wait;
    const down = engine.shutdown(10_000); // asks a1 to stop, then waits for the drain
    // The shutdown's first pass asks a1 (once) before anything else happens.
    await vi.waitFor(() => expect(existsSync(taskStopRequestPath(projectDir, "a1"))).toBe(true), {
      timeout: 5000,
    });
    // tick() has no stop check: b1 starts after the shutdown began and is stopped as it starts,
    // before its planner runs.
    const runB = engine.tick();
    go.a1.open();
    expect((await runA).kind).toBe("ran");
    expect((await runB).kind).toBe("ran");
    expect(await down).toEqual({ stopped: ["a1", "b1"], timedOut: false });
    expect((await store.get("a1"))?.frontmatter.status).toBe("stopped");
    expect((await b.store.get("b1"))?.frontmatter.status).toBe("stopped");
    expect((await b.store.get("b1"))?.body.log).toContain("stopped by server shutdown");
  });

  it("asks both projects to stop when they run a task with the same id", async () => {
    const b = await addProject("b");
    await store.create(newTask(fm({ id: "same" }), "a"));
    await b.store.create(newTask(fm({ id: "same" }), "b"));
    let up = 0;
    const ups = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    mockState.onRun = async (opts) => {
      if (opts.role !== "planner") return;
      ups[up++]!.resolve();
      await hold;
    };
    const runA = engine.tick();
    await ups[0]!.promise;
    const runB = engine.tick();
    await ups[1]!.promise;
    const down = engine.shutdown(10_000);
    await vi.waitFor(
      () => {
        expect(existsSync(taskStopRequestPath(projectDir, "same"))).toBe(true);
        expect(existsSync(taskStopRequestPath(b.dir, "same"))).toBe(true);
      },
      { timeout: 5000 },
    );
    release();
    await runA;
    await runB;
    expect(await down).toEqual({ stopped: ["same", "same"], timedOut: false });
  });

  describe("recovery of interrupted tasks", () => {
    /** A task a dead runner left in running: worktree, live log, no pipeline driving it. */
    const crash = async (id = "t1", withLog = true) => {
      await store.create(newTask(fm({ id }), "Build it."));
      await store.transition(id, "running");
      await ensureWorktree(workDir, id, { root: join(workDir, ".boof-runner-worktrees") });
      if (withLog) {
        await mkdir(workingAreaDir(projectDir, id), { recursive: true });
        await writeFile(join(workingAreaDir(projectDir, id), "log.txt"), "live output line\n");
      }
      const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await new Promise<void>((resolve) => exited.on("exit", () => resolve()));
      await writePidFile(taskPidPath(projectDir, id), { pgid: exited.pid!, command: "node" });
    };
    it("requeues a task left running and keeps the worktree", async () => {
      await crash();
      expect(await engine.recoverInterrupted()).toEqual(["t1"]);
      const t = await store.get("t1");
      expect(t?.frontmatter.status).toBe("pending");
      expect(t?.body.log).toContain("live output line");
      expect(t?.body.log).toContain("### Interrupted\nThe runner stopped unexpectedly");
      expect(t?.body.log).toContain("back in the queue");
      expect(await exists(wtPath())).toBe(true);
      expect(await exists(workingAreaDir(projectDir, "t1"))).toBe(false);
      const events = (await readFile(join(projectDir, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(events.at(-1)).toMatchObject({
        type: "task.status",
        task: "t1",
        from: "running",
        to: "pending",
        by: "runner",
      });
      expect(events.at(-1).reason).toContain("interrupted");
    });

    it("the next run of a requeued task continues in the kept worktree", async () => {
      await crash();
      expect(await engine.recoverInterrupted()).toEqual(["t1"]);
      mockState.prompts = [];
      const cwds: string[] = [];
      mockState.onRun = async (opts) => void cwds.push(opts.cwd);
      const r = await engine.tick();
      expect(r.kind === "ran" && r.outcome.kind).toBe("done");
      expect(cwds.every((c) => c === wtPath())).toBe(true);
      expect(mockState.prompts[0]).toContain("## Previous run interrupted");
      expect(mockState.prompts[0]).toContain("git diff");
    });

    it("is idempotent: a second start recovers nothing", async () => {
      await crash();
      expect(await engine.recoverInterrupted()).toEqual(["t1"]);
      const before = (await store.get("t1"))?.body.log;
      expect(await engine.recoverInterrupted()).toEqual([]);
      expect((await store.get("t1"))?.body.log).toBe(before);
      expect(before?.match(/### Interrupted/g)).toHaveLength(1);
    });

    it("recovers a task with no log.txt and skips an entry with no task.md", async () => {
      await crash("t1", false);
      await mkdir(workingAreaDir(projectDir, "ghost"), { recursive: true });
      expect(await engine.recoverInterrupted()).toEqual(["t1"]);
      expect((await store.get("t1"))?.frontmatter.status).toBe("pending");
      expect(await exists(workingAreaDir(projectDir, "ghost"))).toBe(true);
    });

    it("fails a running task with no pid file even when its agent is alive", async () => {
      await crash();
      await rm(taskPidPath(projectDir, "t1"), { force: true });
      const agent = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
        detached: true,
        stdio: "ignore",
      });
      try {
        expect(await engine.recoverInterrupted()).toEqual(["t1"]);
        const t = await store.get("t1");
        expect(t?.frontmatter.status).toBe("failed");
        expect(t?.body.log).not.toContain("Recovery requeue count:");
        expect(t?.body.log).toContain("agent is not confirmed dead");
        expect(isAlive(agent.pid!)).toBe(true);
      } finally {
        try {
          process.kill(-agent.pid!, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    });

    it("fails a running task while an external run is open", async () => {
      await crash();
      const external = new ExternalRunStore(dataRoot);
      await external.open({
        projectId: project.id,
        taskId: "t1",
        stepId: "step-1",
        kind: "step",
        ttlMs: 60_000,
      });
      expect(await engine.recoverInterrupted()).toEqual(["t1"]);
      const t = await store.get("t1");
      expect(t?.frontmatter.status).toBe("failed");
      expect(t?.body.log).toContain("external run is still open");
      expect(t?.body.log).not.toContain("Recovery requeue count:");
    });

    it("fails after the task has already been requeued once", async () => {
      await crash();
      expect(await engine.recoverInterrupted()).toEqual(["t1"]);
      expect((await store.get("t1"))?.body.log).toContain("Recovery requeue count: 1");
      await store.transition("t1", "running");
      const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await new Promise<void>((resolve) => exited.on("exit", () => resolve()));
      await writePidFile(taskPidPath(projectDir, "t1"), { pgid: exited.pid!, command: "node" });
      expect(await engine.recoverInterrupted()).toEqual(["t1"]);
      const t = await store.get("t1");
      expect(t?.frontmatter.status).toBe("failed");
      expect(t?.body.log).toContain("Recovery requeue count: 1");
      expect(t?.body.log).toContain("already been requeued once");
    });

    it.skipIf(process.platform !== "linux" || !currentBootIdentity())(
      "kills an agent process group a crashed runner left behind, then requeues the task",
      async () => {
        await crash();
        const orphan = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
          detached: true,
          stdio: "ignore",
        });
        const gone = new Promise<void>((r) => orphan.on("exit", () => r()));
        try {
          await writePidFile(taskPidPath(projectDir, "t1"), {
            pgid: orphan.pid!,
            command: "node",
            ownerPid: null,
          });
          expect(await engine.recoverInterrupted()).toEqual(["t1"]);
          await gone;
          expect(isAlive(orphan.pid!)).toBe(false);
          const t = await store.get("t1");
          expect(t?.frontmatter.status).toBe("pending");
          expect(t?.body.log).toContain("### Interrupted\nThe runner stopped unexpectedly");
          expect(t?.body.log).toContain("back in the queue");
          expect(t?.body.log).toContain(
            `The agent process group ${orphan.pid} was still running and was killed.`,
          );
          expect(await exists(workingAreaDir(projectDir, "t1"))).toBe(false);
        } finally {
          try {
            process.kill(-orphan.pid!, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      },
    );

    it.skipIf(process.platform !== "linux" || !currentBootIdentity())(
      "keeps the identity of an agent that is still running in the failed task, so Retry can refuse",
      async () => {
        await crash();
        // The recording runner (this process) is still the agent's parent: recovery must not kill it.
        const live = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
          detached: true,
          stdio: "ignore",
        });
        try {
          await writePidFile(taskPidPath(projectDir, "t1"), {
            pgid: live.pid!,
            command: "node",
            ownerPid: process.pid,
          });
          expect(await engine.recoverInterrupted()).toEqual(["t1"]);
          const t = await store.get("t1");
          expect(t?.frontmatter.status).toBe("failed");
          expect(isAlive(live.pid!)).toBe(true);
          expect(t?.frontmatter.agentProcess).toMatchObject({
            pgid: live.pid,
            command: "node",
            bootId: currentBootIdentity(),
          });
          expect(t?.frontmatter.agentProcess?.startTicks).toEqual(expect.any(Number));
        } finally {
          try {
            process.kill(-live.pid!, "SIGKILL");
          } catch {
            /* gone */
          }
        }
      },
    );

    it("does not store an identity for an agent that was killed or is gone", async () => {
      await crash();
      expect(await engine.recoverInterrupted()).toEqual(["t1"]);
      const t = await store.get("t1");
      expect(t?.frontmatter.status).toBe("pending");
      expect(t?.frontmatter.agentProcess).toBeUndefined();
    });

    it.skipIf(process.platform !== "linux")(
      "off Linux, warns in the Interrupted block that a live agent process may still be running",
      async () => {
        await crash();
        const orphan = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
          detached: true,
          stdio: "ignore",
        });
        const original = Object.getOwnPropertyDescriptor(process, "platform")!;
        try {
          await writePidFile(taskPidPath(projectDir, "t1"), {
            pgid: orphan.pid!,
            command: "node",
            ownerPid: null,
          });
          Object.defineProperty(process, "platform", { ...original, value: "darwin" });
          expect(await engine.recoverInterrupted()).toEqual(["t1"]);
          const t = await store.get("t1");
          expect(t?.frontmatter.status).toBe("failed");
          expect(t?.body.log).toContain(
            `agent process (pid ${orphan.pid}, node) may still be running`,
          );
          expect(t?.body.log).toContain("Stop it before you Retry");
          expect(isAlive(orphan.pid!)).toBe(true);
        } finally {
          Object.defineProperty(process, "platform", original);
          try {
            process.kill(-orphan.pid!, "SIGKILL");
          } catch {
            /* gone */
          }
        }
      },
    );

    it("a pid file whose process already ended changes nothing", async () => {
      await crash();
      const done = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await new Promise<void>((r) => done.on("exit", () => r()));
      await writePidFile(taskPidPath(projectDir, "t1"), { pgid: done.pid!, command: "node" });
      expect(await engine.recoverInterrupted()).toEqual(["t1"]);
      expect((await store.get("t1"))?.frontmatter.status).toBe("pending");
      expect((await store.get("t1"))?.body.log).not.toContain("was still running");
      expect(existsSync(taskPidPath(projectDir, "t1"))).toBe(false);
    });

    it.skipIf(process.platform === "win32")(
      "the pipeline records the step's group under control/pid while the tool runs",
      async () => {
        await store.create(newTask(fm(), "Build it. [[mock-stall planner=1 developer=1]]"));
        const pid = taskPidPath(projectDir, "t1");
        const done = engine.loop();
        try {
          while (!existsSync(pid)) await new Promise((r) => setTimeout(r, 20));
          const rec = JSON.parse(await readFile(pid, "utf8"));
          expect(rec.command).toBe("node");
          expect(isAlive(rec.pgid)).toBe(true);
          await mkdir(taskControlDir(projectDir, "t1"), { recursive: true });
          await writeFile(taskStopRequestPath(projectDir, "t1"), "test\n");
        } finally {
          engine.stop();
          await done;
        }
        expect((await store.get("t1"))?.frontmatter.status).toBe("stopped");
        expect(existsSync(pid)).toBe(false);
      },
      process.platform === "win32" ? 180_000 : 20_000,
    );

    it("does nothing when no engine loop runs (the --no-runner path)", async () => {
      await crash();
      expect((await store.get("t1"))?.frontmatter.status).toBe("running");
    });
  });
});
