import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConciergeEvent, PendingChangeView } from "../api-types.js";
import { initialConciergeUi, reduceConcierge } from "../lib/concierge-session.js";
import type { ConsoleLine } from "../lib/console-session.js";
import { ConfirmChangeBody } from "./ConfirmChangeBody.js";
import { ConsoleLog } from "./ConsoleLog.js";

const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const pending = (over: Partial<PendingChangeView> = {}): PendingChangeView => ({
  id: "chg-1",
  op: "tasks.delete",
  title: 'Delete task "Fix login" (t1)',
  details: [
    "warning: 2 subtasks become top-level tasks",
    "removed: the task file",
    "…and 3 more (3 more fields)",
  ],
  destructive: true,
  reason: "confirm",
  status: "pending",
  expiresAt: "2026-11-06T12:15:00.000Z",
  ...over,
});
const render = (lines: ConsoleLine[], list: PendingChangeView[] = []) =>
  renderToStaticMarkup(
    createElement(ConsoleLog, {
      lines,
      pending: list,
      now: NOW,
      onReview: () => {},
      onDiscard: () => {},
    }),
  );
const run = (events: ConciergeEvent[]) =>
  events.reduce((s, e) => reduceConcierge(s, e), initialConciergeUi("demo"));

describe("streaming render", () => {
  it("grows one assistant line as text arrives", () => {
    const first = run([{ type: "text", text: "There are " }]);
    expect(render(first.lines)).toContain("There are </p>");
    const more = reduceConcierge(first, { type: "text", text: "two tasks." });
    const html = render(more.lines);
    expect(html).toContain("There are two tasks.</p>");
    expect(html.match(/data-kind="assistant"/g)).toHaveLength(1);
  });
});

describe("plain-text rendering", () => {
  it("shows a script tag and a markdown link as literal characters", () => {
    const html = render([
      { kind: "assistant", text: "<script>alert(1)</script> [click](https://evil.example) **b**" },
    ]);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<strong");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("[click](https://evil.example) **b**");
  });

  it("escapes model text in a pending title and in the dialog", () => {
    const evil = pending({ title: '<img src=x onerror="x()">', details: ["<b>bold</b>"] });
    const row = render([{ kind: "pending", text: evil.title, changeId: evil.id }], [evil]);
    expect(row).not.toContain("<img");
    const body = renderToStaticMarkup(createElement(ConfirmChangeBody, { change: evil }));
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<b>");
    expect(body).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("links only the changes the assistant made, to app routes", () => {
    const html = render([
      { kind: "change", text: 'Created task "Fix" (t1)', href: "p/demo/tasks/t1" },
    ]);
    expect(html).toContain('<a href="p/demo/tasks/t1">');
  });
});

describe("proposed changes", () => {
  it("shows Review… and Discard while the change waits", () => {
    const html = render(
      [{ kind: "pending", text: pending().title, changeId: "chg-1" }],
      [pending()],
    );
    expect(html).toContain("Review…");
    expect(html).toContain("Discard");
  });

  it("shows applied, failed (interrupted) and expired instead of the buttons", () => {
    const rows = (line: Partial<ConsoleLine>) =>
      render([{ kind: "pending", text: "t", changeId: "chg-1", ...line }], [pending()]);
    for (const html of [
      rows({ state: "applied" }),
      rows({ state: "failed", detail: "interrupted" }),
      rows({ state: "expired" }),
    ]) {
      expect(html).not.toContain("Review…");
      expect(html).not.toContain("Discard");
    }
    expect(rows({ state: "applied" })).toContain("Applied");
    expect(rows({ state: "failed", detail: "interrupted" })).toContain("Failed: interrupted");
    expect(rows({ state: "expired" })).toContain("Expired");
  });

  it("marks a change expired once its time has passed", () => {
    const late = pending({ expiresAt: "2026-11-06T11:59:00.000Z" });
    const html = render([{ kind: "pending", text: late.title, changeId: late.id }], [late]);
    expect(html).toContain("Expired");
    expect(html).not.toContain("Review…");
  });
});

describe("row accessibility and restored rows", () => {
  it("names each row's buttons by its change", () => {
    const html = render(
      [
        { kind: "pending", text: "Queue A", changeId: "chg-1" },
        { kind: "pending", text: "Queue B", changeId: "chg-2" },
      ],
      [pending({ title: "Queue A" }), pending({ id: "chg-2", title: "Queue B" })],
    );
    for (const label of ["Review: Queue A", "Discard: Queue A", "Review: Queue B"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
  });

  it("shows applying and interrupted changes the status read restored", () => {
    const rows = (c: PendingChangeView) =>
      render([{ kind: "pending", text: c.title, changeId: c.id }], [c]);
    expect(rows(pending({ status: "applying" }))).toContain("Applying…");
    const failed = rows(pending({ status: "failed", error: "interrupted" }));
    expect(failed).toContain("Failed: interrupted");
    expect(failed).not.toContain("Review: ");
  });

  it("keeps restored failed rows when an answer arrives", () => {
    const restored = pending({ id: "chg-9", status: "failed", error: "interrupted" });
    const start = { ...initialConciergeUi("demo"), pending: [restored] };
    const done = reduceConcierge(start, {
      type: "done",
      answer: {
        conversationId: "c1",
        text: "",
        changes: [],
        pending: [pending()],
        costUsd: null,
        stopReason: "done",
      },
    });
    expect(done.pending.map((c) => c.id)).toEqual(["chg-9", "chg-1"]);
  });
});

describe("blocked changes", () => {
  const blocked = pending({
    blocked: "This task has 1 subtask, so it cannot be deleted as proposed.",
  });

  it("shows the reason in the dialog body and not the delete warning", () => {
    const html = renderToStaticMarkup(createElement(ConfirmChangeBody, { change: blocked }));
    expect(html).toContain("This task has 1 subtask, so it cannot be deleted as proposed.");
    expect(html).not.toContain("This cannot be undone");
  });
});

describe("confirm dialog content", () => {
  const html = renderToStaticMarkup(createElement(ConfirmChangeBody, { change: pending() }));
  const at = (s: string) => html.indexOf(s);

  it("shows the title, every detail line, the delete warning and the note", () => {
    for (const s of [
      "Delete task &quot;Fix login&quot; (t1)",
      "removed: the task file",
      "…and 3 more (3 more fields)",
      "Delete this task? Its file, reports and log are removed. This cannot be undone.",
      "Proposed by the assistant. It runs with your permissions.",
    ]) {
      expect(at(s), s).toBeGreaterThan(-1);
    }
  });

  it("keeps the server's order: title, warnings first, the rest, then the more-line", () => {
    const order = [
      "Delete task",
      "warning: 2 subtasks",
      "removed: the task file",
      "…and 3 more",
      "Delete this task?",
      "Proposed by the assistant",
    ].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  it("adds the delete warning only for tasks.delete", () => {
    const other = renderToStaticMarkup(
      createElement(ConfirmChangeBody, {
        change: pending({ op: "tasks.queue", destructive: false, details: [] }),
      }),
    );
    expect(other).not.toContain("This cannot be undone");
  });
});

describe("apply, discard and expired in the session", () => {
  const events: ConciergeEvent[] = [{ type: "pending", change: pending() }];

  it("keeps the row and marks it applied", () => {
    const s = reduceConcierge(run(events), { type: "applied", changeId: "chg-1" });
    expect(s.pending).toEqual([]);
    expect(s.lines.at(-1)).toMatchObject({ kind: "pending", state: "applied" });
  });

  it("marks it discarded", () => {
    const s = reduceConcierge(run(events), { type: "discarded", changeId: "chg-1" });
    expect(s.lines.at(-1)).toMatchObject({ state: "discarded" });
  });

  it("marks it expired when the server says so, and failed on another refusal", () => {
    const expired = reduceConcierge(run(events), {
      type: "failed",
      changeId: "chg-1",
      message: "Pending change expired",
      code: "change_expired",
      final: true,
    });
    expect(expired.lines.find((l) => l.kind === "pending")).toMatchObject({ state: "expired" });
    expect(expired.lines.at(-1)).toEqual({ kind: "system", text: "Pending change expired" });
    const failed = reduceConcierge(run(events), {
      type: "failed",
      changeId: "chg-1",
      message: "The target changed since the assistant proposed this change.",
      code: "change_stale",
      final: true,
    });
    expect(failed.lines.find((l) => l.kind === "pending")).toMatchObject({
      state: "failed",
      detail: "The target changed since the assistant proposed this change.",
    });
  });

  it("leaves the row waiting after a network error", () => {
    const s = reduceConcierge(run(events), {
      type: "failed",
      changeId: "chg-1",
      message: "offline",
    });
    expect(s.pending).toHaveLength(1);
    expect(s.lines.find((l) => l.kind === "pending")?.state).toBeUndefined();
  });
});

describe("refusals in the console", () => {
  it("turns a busy, rate-limit, cap or budget error into plain text", () => {
    const text = (code: string) =>
      reduceConcierge(initialConciergeUi("demo"), { type: "error", code, message: "raw" }).lines.at(
        -1,
      )?.text;
    expect(text("concierge_busy")).toContain("still answering");
    expect(text("rate_limited")).toContain("too fast");
    expect(text("concierge_limit")).toContain("cost limit");
    expect(text("budget_exceeded")).toContain("daily budget");
  });

  it("says so when a turn ends on its cost cap", () => {
    const s = reduceConcierge(initialConciergeUi("demo"), {
      type: "done",
      answer: {
        conversationId: "c1",
        text: "partial",
        changes: [],
        pending: [],
        costUsd: 0.25,
        stopReason: "max_budget",
      },
    });
    expect(s.busy).toBe(false);
    expect(s.lines.at(-1)?.text).toContain("cost limit");
  });
});
