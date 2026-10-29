import { mkdtemp, realpath, rm, writeFile, unlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSettings, SettingsStore } from "@boof-runner/shared";
import { createWorktree, execCommand, MockTool, ToolRegistry } from "@boof-runner/runner";
import { TaskService } from "@boof-runner/api";
import { createApp } from "./app.js";

let root: string;
let repo: string;
let app: ReturnType<typeof createApp>;
let wtRoot: string;

const V1 = "/api/v1";
const call = (path: string, init: RequestInit = {}) => app.request("http://localhost" + path, init);
const g = (cwd: string, args: string[]) =>
  execCommand("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
const diffUrl = (id: string, qs = "") => `${V1}/projects/demo/tasks/${id}/diff${qs}`;

async function mkTask(title: string): Promise<string> {
  const res = await call(`${V1}/projects/demo/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, prompt: "p" }),
  });
  return (await res.json()).frontmatter.id;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boof-diff-"));
  repo = await realpath(await mkdtemp(join(tmpdir(), "boof-diff-repo-")));
  await g(repo, ["init", "-q", "-b", "main"]);
  await writeFile(join(repo, "a.txt"), "one\ntwo\nthree\n");
  await writeFile(join(repo, "b.txt"), "bee\n");
  await writeFile(join(repo, "old.txt"), "a long enough file\nto be a rename\nsource\nfor git\n");
  await g(repo, ["add", "."]);
  await g(repo, ["commit", "-q", "-m", "init"]);
  await new SettingsStore(root).save(defaultSettings());
  const service = new TaskService(root, new ToolRegistry([new MockTool()]));
  await service.projects.create({ workingDirectory: repo, id: "demo" });
  app = createApp({ service, peerAddress: () => "127.0.0.1" });
  wtRoot = join(repo, ".boof-runner-worktrees");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** A task whose branch has one commit: modify a, add c (with a binary), delete b, rename old. */
async function committedTask(title = "Diff me"): Promise<{ id: string; wt: string }> {
  const id = await mkTask(title);
  const { worktree } = await createWorktree(repo, id, { root: wtRoot });
  const wt = worktree.path;
  await writeFile(join(wt, "a.txt"), "one\n2\nthree\nfour\n");
  await writeFile(join(wt, "c.txt"), "new file\n");
  await writeFile(join(wt, "bin.dat"), Buffer.from([0, 1, 2, 0, 255, 0]));
  await unlink(join(wt, "b.txt"));
  await rename(join(wt, "old.txt"), join(wt, "renamed.txt"));
  await g(wt, ["add", "-A"]);
  await g(wt, ["commit", "-q", "-m", "do the work"]);
  return { id, wt };
}

describe("GET /tasks/:id/diff", () => {
  it("lists files, stats, commits and a patch for a task branch", async () => {
    const { id } = await committedTask();
    const res = await call(diffUrl(id));
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.head.ref).toBe(`boof-runner/${id}`);
    const baseSha = (await g(repo, ["rev-parse", "main"])).stdout.trim();
    expect(d.base.sha).toBe(baseSha);
    const by = Object.fromEntries(d.files.map((f: { path: string }) => [f.path, f]));
    expect(by["a.txt"]).toMatchObject({ status: "modified", additions: 2, deletions: 1 });
    expect(by["c.txt"]).toMatchObject({ status: "added", additions: 1, deletions: 0 });
    expect(by["b.txt"]).toMatchObject({ status: "deleted", additions: 0, deletions: 1 });
    expect(by["renamed.txt"]).toMatchObject({ status: "renamed", oldPath: "old.txt" });
    expect(by["bin.dat"].status).toBe("binary");
    expect(d.stats.files).toBe(5);
    expect(d.stats.additions).toBe(3);
    expect(d.commits).toHaveLength(1);
    expect(d.commits[0]).toMatchObject({ subject: "do the work", author: "t" });
    expect(d.patch).toContain("+four");
    expect(d.truncated).toBe(false);
    expect(d.includesUncommitted).toBeUndefined();
  });

  it("returns one file's patch with ?path and honours context", async () => {
    const { id } = await committedTask();
    const d = await (await call(diffUrl(id, "?path=a.txt&context=0"))).json();
    expect(d.patch).toContain("+four");
    expect(d.patch).not.toContain("c.txt");
    expect(d.patch).not.toContain("\n one");
    const none = await (await call(diffUrl(id, "?path=nope.txt"))).json();
    expect(none.patch).toBe("");
  });

  it("rejects paths that leave the repository", async () => {
    const { id } = await committedTask();
    for (const p of ["../x", "a/../../x", "/etc/passwd", "a%00b", "C:/x"]) {
      const res = await call(
        diffUrl(id, `?path=${p.startsWith("a%") ? p : encodeURIComponent(p)}`),
      );
      expect(res.status, p).toBe(400);
    }
  });

  it("is 404 branch_not_found when the branch does not exist", async () => {
    const id = await mkTask("No branch");
    const res = await call(diffUrl(id));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("branch_not_found");
    expect((await call(diffUrl("missing-task"))).status).toBe(404);
  });

  it("includes and flags uncommitted changes of a kept worktree", async () => {
    const { id, wt } = await committedTask();
    await writeFile(join(wt, "a.txt"), "one\n2\nthree\nfour\nfive\n");
    await writeFile(join(wt, "loose.txt"), "untracked\nlines\n");
    const d = await (await call(diffUrl(id))).json();
    expect(d.includesUncommitted).toBe(true);
    const by = Object.fromEntries(d.files.map((f: { path: string }) => [f.path, f]));
    expect(by["a.txt"].additions).toBe(3);
    expect(by["loose.txt"]).toMatchObject({ status: "added", additions: 2 });
    expect(d.patch).toContain("+five");
    expect(d.patch).toContain("+untracked");
    const one = await (await call(diffUrl(id, "?path=loose.txt"))).json();
    expect(one.patch).toContain("+lines");
    expect(one.patch).not.toContain("five");
    // Read-only: the working tree and index are as the task left them.
    const status = (await g(wt, ["status", "--porcelain"])).stdout;
    expect(status).toContain("?? loose.txt");
    expect(status).toContain(" M a.txt");
  });

  it("exposes the leftovers branch when it exists", async () => {
    const { id, wt } = await committedTask();
    await g(wt, ["branch", `boof-runner/${id}--leftovers`]);
    const d = await (await call(diffUrl(id))).json();
    expect(d.leftovers.ref).toBe(`boof-runner/${id}--leftovers`);
  });

  it("leaves the patch out above maxBytes and cuts a single file at it", async () => {
    const id = await mkTask("Big one");
    const { worktree } = await createWorktree(repo, id, { root: wtRoot });
    await writeFile(
      join(worktree.path, "big.txt"),
      "x".repeat(60) + "\n".repeat(1) + "y\n".repeat(2000),
    );
    await g(worktree.path, ["add", "."]);
    await g(worktree.path, ["commit", "-q", "-m", "big"]);
    const d = await (await call(diffUrl(id, "?maxBytes=1000"))).json();
    expect(d.truncated).toBe(true);
    expect(d.patch).toBeUndefined();
    expect(d.files).toHaveLength(1);
    const one = await (await call(diffUrl(id, "?path=big.txt&maxBytes=1000"))).json();
    expect(one.truncated).toBe(true);
    expect(Buffer.byteLength(one.patch)).toBeLessThanOrEqual(1000);
  });
});
