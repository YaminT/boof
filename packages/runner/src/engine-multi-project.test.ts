import { mkdir, mkdtemp, realpath, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  currentStatus,
  newTask,
  ProjectStore,
  parseGoal,
  serializeTask,
  TaskStore,
  taskFilePath,
  initGitRepo,
  isGitRepo,
  repoCommonDir,
} from "@boof/heart";
import { RunnerEngine } from "./engine.js";
import { mockState } from "./tools/mock.js";
import {
  useEngineRig,
  extraRepos,
  fm,
  addProject,
  withoutTools,
  order,
} from "./engine-test-support.js";

let dataRoot: string;
let workDir: string;
let engine: RunnerEngine;
let projectDir: string;
let store: TaskStore;

useEngineRig((rig) => {
  ({ dataRoot, workDir, engine, projectDir, store } = rig);
});

describe("multi-project engine (mock tool)", () => {
  it("a task in a project created with path.mode auto runs with isolation and sees the brief", async () => {
    const projectsRoot = await mkdtemp(join(tmpdir(), "boof-runner-auto-"));
    extraRepos.push(projectsRoot);
    const projects = new ProjectStore(dataRoot, { isGitRepo, repoCommonDir, initGitRepo });
    await projects.create({
      path: { mode: "auto", projectsRoot },
      name: "Fresh",
      brief: "Fresh project.",
      id: "fresh",
    });
    const fresh = new TaskStore(projects.dir("fresh"));
    await fresh.create(newTask(fm({ id: "f1", priority: 90 }), "fresh task"));
    expect(order(await engine.runUntilIdle())).toEqual(["fresh/f1"]);
    const done = await fresh.get("f1");
    expect(done?.frontmatter.status).toBe("done");
    expect(done?.body.log).toContain("worktree at");
    expect(mockState.prompts.some((p) => p.includes("## Project\nFresh project."))).toBe(true);
  });

  it(
    "serves projects in global priority order, interleaved",
    async () => {
      const b = await addProject("b");
      await store.create(newTask(fm({ id: "a-low", priority: 10 }), "a low"));
      await store.create(newTask(fm({ id: "a-mid", priority: 50 }), "a mid"));
      await b.store.create(newTask(fm({ id: "b-high", priority: 90 }), "b high"));
      await b.store.create(newTask(fm({ id: "b-mid", priority: 30 }), "b mid"));

      expect(order(await engine.runUntilIdle())).toEqual([
        "b/b-high",
        "default/a-mid",
        "b/b-mid",
        "default/a-low",
      ]);
      expect((await b.store.get("b-high"))?.frontmatter.status).toBe("done");
      expect((await store.get("a-mid"))?.frontmatter.status).toBe("done");
    },
    process.platform === "win32" ? 180_000 : 20_000,
  );

  it(
    "breaks priority ties by oldest `updated`, then by project id, then by task id",
    async () => {
      const b = await addProject("b");
      const write = (dir: string, id: string, updated: string) =>
        writeFile(
          taskFilePath(dir, "pending", id),
          serializeTask(newTask(fm({ id, priority: 50, updated }), id)),
        );
      await write(projectDir, "newer", "2026-06-04T10:00:05.000Z");
      await write(b.dir, "older", "2026-06-04T10:00:01.000Z");
      // Identical priority and `updated`: project id, then task id decide.
      await write(projectDir, "same-b", "2026-06-04T10:00:09.000Z");
      await write(projectDir, "same-a", "2026-06-04T10:00:09.000Z");
      await write(b.dir, "same-c", "2026-06-04T10:00:09.000Z");

      expect(order(await engine.runUntilIdle())).toEqual([
        "b/older",
        "default/newer",
        "b/same-c", // project "b" sorts before "default"
        "default/same-a",
        "default/same-b",
      ]);
    },
    process.platform === "win32" ? 180_000 : 20_000,
  );

  it("skips paused, archived and directory-less projects, and serves them again once resumed", async () => {
    const b = await addProject("b");
    await b.store.create(newTask(fm({ id: "b1", priority: 99 }), "b1"));
    await store.create(newTask(fm({ id: "a1", priority: 1 }), "a1"));

    await new ProjectStore(dataRoot).update("b", { paused: true });
    expect((await engine.selectNext())?.task.frontmatter.id).toBe("a1");
    await new ProjectStore(dataRoot).update("b", { paused: false, archived: true });
    expect((await engine.selectNext())?.task.frontmatter.id).toBe("a1");
    await new ProjectStore(dataRoot).update("b", { archived: false });
    expect((await engine.selectNext())?.task.frontmatter.id).toBe("b1");

    // A migrated project without a working directory is not runnable.
    await writeFile(
      join(b.dir, "project.json"),
      JSON.stringify({ ...b.project, workingDirectory: "" }),
    );
    expect((await engine.selectNext())?.task.frontmatter.id).toBe("a1");

    expect(order(await engine.runUntilIdle())).toEqual(["default/a1"]);
    expect((await b.store.get("b1"))?.frontmatter.status).toBe("pending");
  });

  it("onlyProject restricts the engine to one project", async () => {
    const b = await addProject("b");
    await b.store.create(newTask(fm({ id: "b1", priority: 99 }), "b1"));
    await store.create(newTask(fm({ id: "a1", priority: 1 }), "a1"));
    const only = new RunnerEngine({ root: dataRoot, onlyProject: "default" });
    expect(order(await only.runUntilIdle())).toEqual(["default/a1"]);
  });

  it("bumpGoalFile writes into the repository of the project the task belongs to", async () => {
    const b = await addProject("b");
    const goalXml = (name: string) => `<?xml version="1.0" encoding="UTF-8"?>
<boof>
  <overal>
    <goal>${name}</goal>
    <stack>TypeScript</stack>
    <rules><do>Write a failing test first.</do></rules>
  </overal>
  <progress>
    <status><versions><version number="1" status="plan">seed</version></versions></status>
    <tests><strategy>TDD</strategy><technology>vitest</technology><run>npm test</run></tests>
  </progress>
</boof>`;
    for (const repo of [workDir, b.repo]) {
      await mkdir(join(repo, "core"), { recursive: true });
      await writeFile(join(repo, "core", "goal.boof.xml"), goalXml("core"), "utf8");
    }
    // The same relative path in both repos; only project b's task completes.
    await b.store.create(
      newTask(fm({ id: "bt", boofGoal: { path: "core/goal.boof.xml", bumpTo: "done" } }), "b"),
    );
    expect(order(await engine.runUntilIdle())).toEqual(["b/bt"]);

    const read = async (repo: string) =>
      parseGoal(await readFile(join(repo, "core", "goal.boof.xml"), "utf8"));
    expect(currentStatus(await read(b.repo))).toBe("done");
    expect(currentStatus(await read(workDir))).toBe("plan");
  });

  it(
    "honours a per-project worktree root override and project-level role overrides",
    async () => {
      const b = await addProject("b");
      const wtRoot = await realpath(await mkdtemp(join(tmpdir(), "boof-runner-wt-")));
      extraRepos.push(wtRoot);
      await new ProjectStore(dataRoot).update("b", {
        worktree: { root: wtRoot },
        roles: { developer: { tool: "mock", model: "project-dev" } },
      });
      const cwds: string[] = [];
      const models: string[] = [];
      mockState.onRun = async (opts) => {
        cwds.push(opts.cwd);
        if (opts.role === "developer") models.push(opts.model);
      };
      // No per-task tools: roles come from global settings + the project's override.
      await engine.settingsStore.update({
        roles: {
          planner: { tool: "mock", model: "g-plan" },
          developer: { tool: "mock", model: "g-dev" },
          reviewer: { tool: "mock", model: "g-rev" },
        },
      });
      await b.store.create(newTask(withoutTools(fm({ id: "bt" })), "b"));
      await store.create(newTask(withoutTools(fm({ id: "at", priority: 10 })), "a"));
      expect(order(await engine.runUntilIdle())).toEqual(["b/bt", "default/at"]);

      const normalized = (path: string) => path.replaceAll("\\", "/").toLowerCase();
      const bCwds = cwds.filter((c) => normalized(c).startsWith(`${normalized(wtRoot)}/`));
      const aCwds = cwds.filter((c) =>
        normalized(c).startsWith(`${normalized(join(workDir, ".boof-runner-worktrees"))}/`),
      );
      expect(bCwds.length).toBeGreaterThan(0);
      expect(aCwds.length).toBeGreaterThan(0);
      expect(bCwds.length + aCwds.length).toBe(cwds.length);
      expect(models).toEqual(["project-dev", "g-dev"]);
    },
    process.platform === "win32" ? 180_000 : 20_000,
  );

  /** Tracks how many roles run at once per repository and overall, with a delay in every step. */
  const trackConcurrency = (repos: string[], opts: { rendezvous?: boolean } = {}) => {
    const active = new Map<string, number>();
    const maxPerRepo = new Map<string, number>();
    let activeTotal = 0;
    let maxTotal = 0;
    // With `rendezvous`, the first step of each repository waits until every repository has a
    // step running. Overlap is then guaranteed when the engine runs them together (and a
    // deadlock, ending in a failed task, when it does not), instead of depending on how long a
    // worktree takes to set up on a loaded machine against a fixed delay.
    const arrived = new Set<string>();
    let allArrived!: () => void;
    const together = new Promise<void>((r) => (allArrived = r));
    mockState.onRun = async (run) => {
      const normalized = (path: string) => path.replaceAll("\\", "/").toLowerCase();
      const repo = repos.find((r) => normalized(run.cwd).startsWith(`${normalized(r)}/`)) ?? "?";
      const n = (active.get(repo) ?? 0) + 1;
      active.set(repo, n);
      maxPerRepo.set(repo, Math.max(maxPerRepo.get(repo) ?? 0, n));
      activeTotal += 1;
      maxTotal = Math.max(maxTotal, activeTotal);
      if (opts.rendezvous && !arrived.has(repo)) {
        arrived.add(repo);
        if (arrived.size === repos.length) allArrived();
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            together,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("the other project never started a step")),
                10_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      await new Promise((r) => setTimeout(r, 25));
      active.set(repo, (active.get(repo) ?? 1) - 1);
      activeTotal -= 1;
    };
    return { maxPerRepo, maxTotal: () => maxTotal };
  };

  it(
    "concurrency=2 runs two projects at once but never two tasks of one project",
    async () => {
      const b = await addProject("b");
      await engine.settingsStore.update({ runner: { concurrency: 2 } });
      for (const [s, label] of [
        [store, "a"],
        [b.store, "b"],
      ] as const) {
        await s.create(newTask(fm({ id: `${label}1`, priority: 50 }), `${label}1`));
        await s.create(newTask(fm({ id: `${label}2`, priority: 40 }), `${label}2`));
      }
      const track = trackConcurrency([workDir, b.repo], { rendezvous: true });

      const results = await engine.runUntilIdle();
      expect(order(results).sort()).toEqual(["b/b1", "b/b2", "default/a1", "default/a2"]);
      expect(track.maxTotal()).toBe(2); // two projects overlapped
      expect(track.maxPerRepo.get(workDir)).toBe(1); // never two steps of one project at once
      expect(track.maxPerRepo.get(b.repo)).toBe(1);
      for (const id of ["a1", "a2"]) expect((await store.get(id))?.frontmatter.status).toBe("done");
      for (const id of ["b1", "b2"])
        expect((await b.store.get(id))?.frontmatter.status).toBe("done");
    },
    process.platform === "win32" ? 180_000 : 20_000,
  );

  it("concurrency=2 with a single project still runs its tasks one after the other", async () => {
    await engine.settingsStore.update({ runner: { concurrency: 2 } });
    await store.create(newTask(fm({ id: "t1", priority: 50 }), "t1"));
    await store.create(newTask(fm({ id: "t2", priority: 40 }), "t2"));
    const track = trackConcurrency([workDir]);

    expect(order(await engine.runUntilIdle())).toEqual(["default/t1", "default/t2"]);
    expect(track.maxTotal()).toBe(1);
  });

  it("selectNext skips a project that has a task in flight", async () => {
    await engine.settingsStore.update({ runner: { concurrency: 2 } });
    await store.create(newTask(fm({ id: "t1", priority: 50 }), "t1"));
    await store.create(newTask(fm({ id: "t2", priority: 40 }), "t2"));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    mockState.onRun = async () => {
      started();
      await gate;
    };
    const first = engine.tick();
    await running;
    expect(await engine.selectNext()).toBeNull(); // t2 waits: its project is busy
    release();
    expect((await first).kind).toBe("ran");
    expect((await engine.selectNext())?.task.frontmatter.id).toBe("t2");
  });

  it("loop() drains two projects and stops cooperatively", async () => {
    const b = await addProject("b");
    await store.create(newTask(fm({ id: "a1" }), "a1"));
    await b.store.create(newTask(fm({ id: "b1" }), "b1"));
    const done = engine.loop();
    // Two mock tasks take over ten seconds on a Windows runner; give the poll as long as the test.
    for (let i = 0; i < (process.platform === "win32" ? 4000 : 400); i += 1) {
      const a = await store.get("a1");
      const c = await b.store.get("b1");
      if (a?.frontmatter.status === "done" && c?.frontmatter.status === "done") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    engine.stop();
    await done;
    expect((await store.get("a1"))?.frontmatter.status).toBe("done");
    expect((await b.store.get("b1"))?.frontmatter.status).toBe("done");
  });
});
