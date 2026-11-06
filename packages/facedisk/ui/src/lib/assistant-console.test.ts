import { describe, expect, it, vi } from "vitest";
import type { PendingChangeView } from "../api-types.js";
import {
  changeRowView,
  confirmButton,
  mergeLines,
  planUnknownInput,
  refusalText,
  runConfirm,
  stopReasonText,
  unavailableLine,
} from "./assistant-console.js";
import type { ConsoleLine } from "./console-session.js";

const change = (over: Partial<PendingChangeView> = {}): PendingChangeView => ({
  id: "chg-1",
  op: "tasks.queue",
  title: 'Queue task "Fix" (t1)',
  details: [],
  destructive: false,
  reason: "confirm",
  status: "pending",
  expiresAt: "2026-11-06T12:15:00.000Z",
  ...over,
});
const consoleA: ConsoleLine = { kind: "result", text: 'unknown command: "hello"' };
const available = { available: true, reason: null, noProject: false };

describe("unavailable mode", () => {
  it("prints the plan's one line with the server's reason, and sends nothing", () => {
    const reason = "The assistant is turned off (settings.concierge.enabled is false).";
    const plan = planUnknownInput(
      "what is running?",
      { available: false, reason, noProject: false },
      consoleA,
    );
    expect(plan).toEqual({
      kind: "print",
      lines: [
        {
          kind: "system",
          text: `Assistant unavailable: ${reason} Commands still work: try /task, /queue, /stop, /open.`,
        },
        consoleA,
      ],
    });
  });

  it("ends the reason with a full stop when the server gave none", () => {
    expect(unavailableLine("Not in the desktop app")).toBe(
      "Assistant unavailable: Not in the desktop app. Commands still work: try /task, /queue, /stop, /open.",
    );
  });

  it("works as Console A when there is no assistant at all", () => {
    expect(planUnknownInput("hello", undefined, consoleA)).toEqual({
      kind: "print",
      lines: [consoleA],
    });
  });
});

describe("free text", () => {
  it("goes to the assistant when it is available", () => {
    expect(planUnknownInput("create a task to fix the login", available, consoleA)).toEqual({
      kind: "ask",
    });
  });

  it("never sends a mistyped slash command to the assistant", () => {
    expect(planUnknownInput("/tsak fix", available, consoleA)).toEqual({
      kind: "print",
      lines: [consoleA],
    });
  });

  it("asks for a project first", () => {
    expect(
      planUnknownInput("hello", { available: false, reason: null, noProject: true }, consoleA),
    ).toEqual({
      kind: "print",
      lines: [{ kind: "system", text: "Choose a project to ask the assistant." }],
    });
  });
});

describe("the refusal messages", () => {
  it("says busy, rate limit, cap and budget in plain words", () => {
    expect(refusalText("concierge_busy", "x")).toBe(
      "The assistant is still answering your last message. Wait for it, or press Stop.",
    );
    expect(refusalText("rate_limited", "x")).toContain("too fast");
    expect(refusalText("concierge_limit", "x")).toContain("/new");
    expect(refusalText("budget_exceeded", "x")).toContain("daily budget");
  });

  it("passes any other server message through unchanged", () => {
    expect(refusalText("concierge_unavailable", "No key <b>set</b>.")).toBe("No key <b>set</b>.");
  });

  it("explains a turn that ended on a cap", () => {
    expect(stopReasonText("done")).toBeNull();
    expect(stopReasonText("max_budget")).toContain("cost limit");
    expect(stopReasonText("max_turns")).toContain("step limit");
  });
});

describe("mergeLines", () => {
  it("places the console's own rows where they were printed", () => {
    const assistant: ConsoleLine[] = [
      { kind: "input", text: "hi" },
      { kind: "assistant", text: "hello" },
    ];
    const merged = mergeLines(
      [
        { kind: "result", text: "A", at: 0 },
        { kind: "result", text: "B", at: 1 },
        { kind: "result", text: "C", at: 99 },
      ],
      assistant,
    );
    expect(merged.map((l) => l.text)).toEqual(["A", "> hi", "B", "hello", "C"]);
  });
});

describe("pending row state", () => {
  const now = Date.parse("2026-11-06T12:00:00.000Z");
  const line: ConsoleLine = { kind: "pending", text: "t", changeId: "chg-1" };

  it("waits for the user while the change is live", () => {
    expect(changeRowView(line, [change()], now)).toEqual({ kind: "waiting", change: change() });
  });

  it("shows expired once the time has passed", () => {
    expect(changeRowView(line, [change()], Date.parse("2026-11-06T12:15:01.000Z"))).toEqual({
      kind: "done",
      label: "Expired",
    });
    expect(changeRowView(line, [change({ status: "expired" })], now)).toEqual({
      kind: "done",
      label: "Expired",
    });
  });

  it("shows applied, discarded and failed with the reason", () => {
    expect(changeRowView({ ...line, state: "applied" }, [], now)).toEqual({
      kind: "done",
      label: "Applied",
    });
    expect(changeRowView({ ...line, state: "discarded" }, [], now)).toEqual({
      kind: "done",
      label: "Discarded",
    });
    expect(changeRowView({ ...line, state: "failed", detail: "interrupted" }, [], now)).toEqual({
      kind: "done",
      label: "Failed: interrupted",
    });
    expect(changeRowView(line, [change({ status: "failed" })], now)).toEqual({
      kind: "done",
      label: "Failed",
    });
  });
});

describe("confirm button", () => {
  it("is a red Confirm for a destructive change and Apply for the rest", () => {
    expect(confirmButton({ destructive: true })).toEqual({
      label: "Confirm",
      variant: "destructive",
    });
    expect(confirmButton({ destructive: false })).toEqual({ label: "Apply", variant: "default" });
  });
});

function harness() {
  let running = false;
  const log = { error: [] as (string | null)[], closed: 0 };
  return {
    log,
    ui: {
      running: () => running,
      setRunning: (on: boolean) => (running = on),
      setError: (m: string | null) => log.error.push(m),
      close: () => (log.closed += 1),
    },
  };
}

describe("runConfirm (apply)", () => {
  it("runs the change once and closes", async () => {
    const h = harness();
    const apply = vi.fn().mockResolvedValue(undefined);
    await runConfirm(apply, h.ui);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(h.log.closed).toBe(1);
  });

  it("keeps the dialog open and shows the message when apply is refused", async () => {
    const h = harness();
    await runConfirm(() => Promise.reject(new Error("Pending change expired")), h.ui);
    expect(h.log.closed).toBe(0);
    expect(h.log.error.at(-1)).toBe("Pending change expired");
  });

  it("ignores a second press while the first is running", async () => {
    const h = harness();
    let release: () => void = () => {};
    const apply = vi.fn(() => new Promise<void>((r) => (release = r)));
    const first = runConfirm(apply, h.ui);
    await runConfirm(apply, h.ui);
    release();
    await first;
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
