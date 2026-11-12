import { describe, expect, it, vi } from "vitest";
import type { Scope } from "@boof/heart/schema";
import { ApiError } from "../api.js";
import type { CommandAction } from "./command-actions.js";
import {
  appendOutput,
  pushHistory,
  recall,
  submitConsole,
  type ConsoleLine,
} from "./console-session.js";

const result = (text: string): ConsoleLine => ({ kind: "result", text });

const action = (id: string, run: () => unknown, requiredScope?: Scope): CommandAction => ({
  id,
  label: id,
  group: "Actions",
  searchValue: id,
  keywords: [],
  requiredScope,
  run: run as CommandAction["run"],
});

describe("pushHistory", () => {
  it("keeps raw text, skips blanks and immediate repeats, and is bounded", () => {
    let h: string[] = [];
    for (const s of ["a", "  ", "a", " /queue t1 ", "b"]) h = pushHistory(h, s, 3);
    expect(h).toEqual(["a", "/queue t1", "b"]);
    expect(pushHistory(h, "c", 3)).toEqual(["/queue t1", "b", "c"]);
  });
});

describe("recall", () => {
  const h = ["one", "two", "three"];
  it("walks back through history and returns to the draft", () => {
    let r = recall(h, { index: null, draft: "" }, "up", "half-typed");
    expect(r.text).toBe("three");
    r = recall(h, r.state, "up", r.text);
    expect(r.text).toBe("two");
    r = recall(h, r.state, "up", r.text);
    r = recall(h, r.state, "up", r.text);
    expect(r.text).toBe("one");
    r = recall(h, r.state, "down", r.text);
    expect(r.text).toBe("two");
    r = recall(h, r.state, "down", r.text);
    r = recall(h, r.state, "down", r.text);
    expect(r.text).toBe("half-typed");
    expect(r.state.index).toBeNull();
  });
  it("does nothing on an empty history or when already at the draft", () => {
    expect(recall([], { index: null, draft: "" }, "up", "x").text).toBe("x");
    expect(recall(h, { index: null, draft: "" }, "down", "x").text).toBe("x");
  });
});

describe("appendOutput", () => {
  it("keeps the newest lines", () => {
    expect(appendOutput([result("1"), result("2")], result("3"), 2)).toEqual([
      result("2"),
      result("3"),
    ]);
  });
});

describe("submitConsole", () => {
  it("runs the action once and reports ok", async () => {
    const run = vi.fn();
    const r = await submitConsole("go-x", [action("go-x", run)], "all");
    expect(run).toHaveBeenCalledOnce();
    expect(r.line).toEqual(result("ok: go-x"));
  });

  it("hands the typed arguments to the action", async () => {
    const run = vi.fn();
    await submitConsole("/epic Payments", [action("new-epic", run)], "all");
    expect(run).toHaveBeenCalledExactlyOnceWith("Payments");
  });

  it("reports a refusal as an error line, never ok", async () => {
    const run = vi.fn().mockRejectedValue(new ApiError("not allowed", 403, "forbidden"));
    const r = await submitConsole("go-x", [action("go-x", run)], "all");
    expect(r.line).toEqual(result("error: go-x: not allowed"));
    expect(r.outcome.kind).toBe("error");
  });

  it("reports a throw from a synchronous action too", async () => {
    const r = await submitConsole(
      "go-x",
      [
        action("go-x", () => {
          throw new Error("boom");
        }),
      ],
      "all",
    );
    expect(r.line).toEqual(result("error: go-x: boom"));
  });

  it("does not run an action the held scopes lack", async () => {
    const run = vi.fn();
    const r = await submitConsole(
      "q",
      [action("q", run, "tasks:write")],
      new Set<Scope>(["tasks:read"]),
    );
    expect(run).not.toHaveBeenCalled();
    expect(r.outcome.kind).toBe("unknown");
  });

  it("answers unknown input without running anything", async () => {
    const r = await submitConsole("/nope", [], "all");
    expect(r.line.text).toContain('unknown: "/nope"');
    expect(r.line.kind).toBe("result");
  });
});

describe("submitConsole suggestions", () => {
  it("returns the prefill and does not run anything", async () => {
    const run = vi.fn();
    const action = {
      id: "activate-plan-p1",
      label: "Create tasks from plan: Launch",
      group: "Actions",
      searchValue: "x",
      keywords: [],
      targetTitle: "Launch",
      run,
    } as unknown as CommandAction;
    const r = await submitConsole("make tasks out of the plans", [action], "all");
    expect(r.prefill).toBe("/activate Launch");
    expect(r.line.text).toContain("Did you mean: /activate Launch?");
    expect(run).not.toHaveBeenCalled();
  });
});
