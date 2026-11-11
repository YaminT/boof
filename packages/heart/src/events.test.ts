import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BoofEventSchema,
  EVENT_TYPES,
  appendEvent,
  encodePos,
  eventsEnd,
  parsePos,
  readEvents,
} from "./events.js";
import { PlanStore } from "./plan-store.js";
import { TaskStore } from "./store.js";
import { newTask } from "./task-file.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boof-events-"));
});
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const runner = (value: boolean) => ({ type: "runner.enabled" as const, value, by: "local" });

describe("events", () => {
  it("lets overlapping readers share one listing and still see the events", async () => {
    await appendEvent(dir, runner(true), new Date("2026-10-01T00:00:00Z"));
    const [a, b] = await Promise.all([readEvents(dir, null), readEvents(dir, null)]);
    expect(a.map((e) => e.event.type)).toEqual(["runner.enabled"]);
    expect(b.map((e) => e.pos)).toEqual(a.map((e) => e.pos));
    await appendEvent(dir, runner(false), new Date("2026-10-02T00:00:00Z"));
    expect(await readEvents(dir, a[0]!.pos)).toHaveLength(1);
  });

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

  it("validates Agent SDK auth refusal events", async () => {
    const event = {
      type: "runner.agent_auth_refused" as const,
      projectId: "p1",
      taskId: "t1",
      reason: "refused",
    };
    expect(BoofEventSchema.safeParse({ ...event, ts: "2026-11-05T00:00:00.000Z" }).success).toBe(
      true,
    );
    await appendEvent(dir, event);
    expect((await readEvents(dir, null))[0]?.event.type).toBe(event.type);
    expect(EVENT_TYPES).toContain(event.type);
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
      "task.created",
      "task.status",
      "task.status",
      "task.questions",
      "plan.updated",
      "plan.updated",
    ]);
    expect(events[2]).toMatchObject({ from: "running", to: "action", by: "client:x" });
    expect(events[3]).toMatchObject({ count: 2 });
    expect(events[5]).toMatchObject({ plan: "p", version: plan.version + 1, by: "client:h" });
  });
});

describe("hierarchy events", () => {
  it("parses task.moved and epic.updated lines", async () => {
    await appendEvent(dir, {
      type: "task.moved",
      project: "p",
      task: "t1",
      from: { epicId: null, parentId: null },
      to: { epicId: "web", parentId: null },
      by: "local",
    });
    await appendEvent(dir, {
      type: "epic.updated",
      project: "p",
      epic: "web",
      change: "created",
      by: "local",
    });
    const got = await readEvents(dir, null);
    expect(got.map((e) => e.event.type)).toEqual(["task.moved", "epic.updated"]);
  });
});

describe("EVENT_TYPES", () => {
  it("lists exactly the types of BoofEventSchema", () => {
    const types = BoofEventSchema.options.map((o) => o.shape.type.value);
    expect([...EVENT_TYPES].sort()).toEqual([...types].sort());
  });
});
