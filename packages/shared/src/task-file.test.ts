import { describe, expect, it } from "vitest";
import { parseTask, serializeTask, newTask } from "./task-file.js";
import type { TaskFrontmatter } from "./schema.js";

const fm = (over: Partial<TaskFrontmatter> = {}): TaskFrontmatter => ({
  id: "add-auth",
  title: "Add auth",
  status: "pending",
  priority: 50,
  skip: false,
  labels: ["backend"],
  command: null,
  attachments: [],
  questions: "none",
  runs: 1,
  completedRuns: 0,
  created: "2026-06-04T10:00:00.000Z",
  updated: "2026-06-04T10:00:00.000Z",
  ...over,
});

describe("task-file observer section", () => {
  it("parses an old file without an Observer section", () => {
    const raw = `---
id: old-task
title: Old
status: done
priority: 0
skip: false
created: 2026-06-04T10:00:00.000Z
updated: 2026-06-04T10:00:00.000Z
---

## Prompt

hi

## Reports

### Planner

plan

### Developer

dev

### Reviewer

rev
`;
    const t = parseTask(raw);
    expect(t.body.reports.observer).toBe("");
    expect(t.body.reports.developer).toBe("dev");
    expect(t.body.reports.reviewer).toBe("rev");
  });

  it("round-trips the observer report between developer and reviewer", () => {
    const task = newTask(fm(), "p");
    task.body.reports.developer = "dev";
    task.body.reports.observer = "obs findings";
    task.body.reports.reviewer = "rev";
    const out = serializeTask(task);
    expect(out.indexOf("### Developer")).toBeLessThan(out.indexOf("### Observer"));
    expect(out.indexOf("### Observer")).toBeLessThan(out.indexOf("### Reviewer"));
    const back = parseTask(out);
    expect(back.body.reports).toEqual(task.body.reports);
  });

  it("accepts tools.observer in frontmatter", () => {
    const task = newTask(fm({ tools: { observer: { tool: "mock", model: "m" } } }));
    expect(parseTask(serializeTask(task)).frontmatter.tools?.observer?.tool).toBe("mock");
  });
});

describe("task-file round-trip", () => {
  it("round-trips frontmatter and body sections", () => {
    const task = newTask(fm(), "Build a login form.");
    task.body.reports.planner = "Plan: do the thing.";
    const serialized = serializeTask(task);
    const reparsed = parseTask(serialized);

    expect(reparsed.frontmatter).toEqual(task.frontmatter);
    expect(reparsed.body.prompt).toBe("Build a login form.");
    expect(reparsed.body.reports.planner).toBe("Plan: do the thing.");
    expect(reparsed.body.reports.developer).toBe("");
  });

  it("treats missing body sections as empty and re-adds headers", () => {
    const raw = `---
id: x-task
title: X
status: draft
priority: 0
skip: false
labels: []
command: null
questions: none
created: 2026-06-04T10:00:00.000Z
updated: 2026-06-04T10:00:00.000Z
---

## Prompt

Only a prompt here.
`;
    const task = parseTask(raw);
    expect(task.body.prompt).toBe("Only a prompt here.");
    expect(task.body.answers).toBe("");
    const out = serializeTask(task);
    expect(out).toContain("## Answers");
    expect(out).toContain("### Reviewer");
  });

  it("rejects invalid status", () => {
    const raw = `---
id: x
title: X
status: bogus
priority: 0
skip: false
labels: []
command: null
questions: none
created: 2026-06-04T10:00:00.000Z
updated: 2026-06-04T10:00:00.000Z
---
## Prompt
`;
    expect(() => parseTask(raw)).toThrow();
  });

  it("accepts a per-task tools override", () => {
    const task = newTask(fm({ tools: { developer: { tool: "codex", model: "gpt-5.4" } } }));
    const reparsed = parseTask(serializeTask(task));
    expect(reparsed.frontmatter.tools?.developer?.tool).toBe("codex");
  });
});
