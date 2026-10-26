import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, encodePos, eventsEnd, parsePos, readEvents } from "./events.js";
import { PlanStore } from "./plan-store.js";
import { TaskStore } from "./store.js";
import { newTask } from "./task-file.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boof-events-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const runner = (value: boolean) => ({ type: "runner.enabled" as const, value, by: "local" });

describe("events", () => {
  it("appends and reads back in order, resuming from a position", async () => {
    await appendEvent(dir, runner(true), new Date("2026-10-01T00:00:00Z"));
    await appendEvent(dir, runner(false), new Date("2026-10-02T00:00:00Z"));
    const all = await readEvents(dir, null);
    expect(all.map((e) => (e.event as { value: boolean }).value)).toEqual([true, false]);
    const rest = await readEvents(dir, all[0].pos);
    expect(rest).toHaveLength(1);
    expect(await readEvents(dir, all[1].pos)).toEqual([]);
    expect(await eventsEnd(dir)).toEqual(all[1].pos);
  });

  it("round-trips a position through its text form", () => {
    expect(parsePos(encodePos({ month: "2026-10", offset: 42 }))).toEqual({
      month: "2026-10",
      offset: 42,
    });
    expect(parsePos("nonsense")).toBeNull();
  });

  it("rotates on the first append of a new month and keeps positions valid", async () => {
    await appendEvent(dir, runner(true), new Date("2026-09-30T23:00:00Z"));
    const [first] = await readEvents(dir, null);
    await appendEvent(dir, runner(false), new Date("2026-10-01T01:00:00Z"));
    expect((await readdir(dir)).sort()).toEqual(["events-2026-09.jsonl", "events.jsonl"]);
    // A position taken before the rotation still resolves (the file now has a month name).
    const after = await readEvents(dir, first.pos);
    expect(after.map((e) => (e.event as { value: boolean }).value)).toEqual([false]);
    expect(await readEvents(dir, null)).toHaveLength(2);
  });

  it("skips corrupt lines and leaves an unfinished last line for later", async () => {
    await appendEvent(dir, runner(true), new Date("2026-10-01T00:00:00Z"));
    const path = join(dir, "events.jsonl");
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, "not json\n");
    await appendFile(path, '{"ts":"2026-10-01T00:00:01.000Z","type":"runner.enabled","va');
    const got = await readEvents(dir, null);
    expect(got).toHaveLength(1);
    await writeFile(path, "");
    expect(await readEvents(dir, null)).toEqual([]);
  });

  it("is written by TaskStore.transition and PlanStore.save", async () => {
    const store = new TaskStore(dir);
    await store.create(
      newTask({
        id: "t1",
        title: "T",
        status: "pending",
        priority: 1,
        skip: false,
        labels: [],
        command: null,
        attachments: [],
        questions: "none",
        runs: 1,
        completedRuns: 0,
        created: "",
        updated: "",
      }),
    );
    await store.transition("t1", "running");
    await store.transition(
      "t1",
      "action",
      (t) => {
        t.frontmatter.questions = "pending";
        t.body.questions = "1. a\n2. b";
      },
      { by: "client:x" },
    );
    const plans = new PlanStore(dir);
    const plan = await plans.create({
      id: "p",
      title: "P",
      source: { kind: "ui" },
    });
    await plans.modify("p", (p) => ({ ...p, title: "P2" }), { by: "client:h" });
    const events = (await readEvents(dir, null)).map((e) => e.event);
    expect(events.map((e) => e.type)).toEqual([
      "task.status",
      "task.status",
      "task.questions",
      "plan.updated",
      "plan.updated",
    ]);
    expect(events[1]).toMatchObject({ from: "running", to: "action", by: "client:x" });
    expect(events[2]).toMatchObject({ count: 2 });
    expect(events[4]).toMatchObject({ plan: "p", version: plan.version + 1, by: "client:h" });
  });
});
