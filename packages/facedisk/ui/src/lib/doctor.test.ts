import { describe, expect, it } from "vitest";
import type { DoctorCheck, HarnessStatus } from "../api-types.js";
import {
  blockReason,
  compactSummary,
  continueRoute,
  hintParts,
  needsAttention,
  fixRoute,
  forgetEntry,
  gateOf,
  reachableWhileBlocked,
  recallEntry,
  rememberEntry,
  summarize,
} from "./doctor.js";

const status = (anyReady: boolean): HarnessStatus => ({
  tools: {},
  anyInstalled: anyReady,
  anyReady,
  gateway: { status: "ok", message: "" },
  checks: [],
  checkedAt: "",
});

describe("gateOf", () => {
  it("is open when an agent is ready and blocked when none is", () => {
    expect(gateOf({ status: status(true), loading: false, failed: false })).toBe("open");
    expect(gateOf({ status: status(false), loading: false, failed: false })).toBe("blocked");
  });
  it("waits for the first answer", () => {
    expect(gateOf({ status: null, loading: true, failed: false })).toBe("checking");
  });
  it("does not lock the app on a failed or refused read; the server still refuses work", () => {
    expect(gateOf({ status: null, loading: false, failed: true })).toBe("unknown");
  });
  it("trusts the latest answer over an older failure", () => {
    expect(gateOf({ status: status(false), loading: false, failed: true })).toBe("blocked");
  });
});

describe("reachableWhileBlocked", () => {
  it("leaves only the doctor and Settings open", () => {
    expect(reachableWhileBlocked({ name: "doctor" })).toBe(true);
    expect(reachableWhileBlocked({ name: "settings", pid: "a", page: "accounts" })).toBe(true);
    for (const r of [
      { name: "overview", pid: "a" },
      { name: "tasks", pid: "a" },
      { name: "task", pid: "a", taskId: "t", view: "edit" },
      { name: "plans", pid: "a" },
      { name: "wizard", pid: "a" },
      { name: "inbox" },
    ] as const)
      expect(reachableWhileBlocked(r)).toBe(false);
    expect(reachableWhileBlocked(null)).toBe(false);
  });
});

describe("fixRoute", () => {
  it("links each fix to its Settings section, with a placeholder project before one exists", () => {
    expect(fixRoute("gateway", "alpha")).toEqual({
      name: "settings",
      pid: "alpha",
      page: "accounts",
    });
    expect(fixRoute("agents", null)).toEqual({ name: "settings", pid: "setup", page: "agents" });
    expect(fixRoute(undefined, "alpha")).toBeNull();
  });
});

describe("summarize", () => {
  const c = (s: DoctorCheck["status"]): DoctorCheck => ({
    id: "git",
    label: "g",
    status: s,
    message: "",
  });
  it("counts failures and warnings", () => {
    expect(summarize([c("pass"), c("warn"), c("warn")])).toEqual({
      passed: true,
      fails: 0,
      warns: 2,
    });
    expect(summarize([c("fail"), c("pass")])).toEqual({ passed: false, fails: 1, warns: 0 });
  });
});

describe("continueRoute", () => {
  it("returns to the page the app was opened on when it still exists", () => {
    const entry = { name: "tasks", pid: "a" } as const;
    expect(continueRoute(entry, "a", ["a"])).toEqual(entry);
    expect(continueRoute({ name: "inbox" }, "a", ["a"])).toEqual({ name: "inbox" });
  });
  it("falls back to the selected project's Overview", () => {
    expect(continueRoute(null, "a", ["a"])).toEqual({ name: "overview", pid: "a" });
    expect(continueRoute({ name: "doctor" }, "a", ["a"])).toEqual({ name: "overview", pid: "a" });
    expect(continueRoute({ name: "tasks", pid: "gone" }, "a", ["a"])).toEqual({
      name: "overview",
      pid: "a",
    });
  });
  it("has nowhere to go before a project exists", () => {
    expect(continueRoute(null, null, [])).toBeNull();
  });
});

describe("remembered entry", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };
  it("keeps the wizard page across a reload of the doctor", () => {
    const st = mem();
    rememberEntry(st, { name: "wizard", pid: "a" });
    expect(recallEntry(st)).toEqual({ name: "wizard", pid: "a" });
    forgetEntry(st);
    expect(recallEntry(st)).toBeNull();
  });
  it("never remembers the doctor itself", () => {
    const st = mem();
    rememberEntry(st, { name: "doctor" });
    expect(recallEntry(st)).toBeNull();
  });
});

describe("blockReason / gateOf", () => {
  const withCheck = (anyReady: boolean, c: DoctorCheck[]): HarnessStatus => ({
    ...status(anyReady),
    checks: c,
  });
  const c = (id: DoctorCheck["id"], st: DoctorCheck["status"]): DoctorCheck => ({
    id,
    label: id,
    status: st,
    message: "",
  });
  it("blocks only when no agent is ready or git or the data folder hard-fails", () => {
    expect(blockReason(withCheck(false, []))).toMatch(/no coding agent/);
    expect(blockReason(withCheck(true, [c("git", "fail")]))).toMatch(/git/);
    expect(blockReason(withCheck(true, [c("dataRoot", "fail")]))).toMatch(/dataRoot/);
  });
  it("never blocks on warnings or other failures when an agent is ready", () => {
    const warns = withCheck(true, [
      c("sandbox", "warn"),
      c("gateway", "warn"),
      c("projectsRoot", "warn"),
    ]);
    expect(blockReason(warns)).toBeNull();
    expect(gateOf({ status: warns, loading: false, failed: false })).toBe("open");
    expect(blockReason(withCheck(true, [c("projectsRoot", "fail")]))).toBeNull();
  });
});

describe("hintParts", () => {
  it("links Settings to the fix page, an API key to the project page, an install to Agents", () => {
    const gw = hintParts("Configure the better-ccflare gateway in Settings.", "gateway", "a");
    expect(gw.find((p) => p.route)).toEqual({
      text: "Settings",
      route: { name: "settings", pid: "a", page: "accounts" },
    });
    const both = hintParts(
      "Configure it in Settings, or set an Anthropic API key.",
      "gateway",
      "a",
    );
    expect(both.filter((p) => p.route).map((p) => (p.route as { page: string }).page)).toEqual([
      "accounts",
      "project",
    ]);
    const inst = hintParts("Install claude-code.", "agents", null);
    expect(inst.find((p) => p.route)?.route).toEqual({
      name: "settings",
      pid: "setup",
      page: "agents",
    });
    expect(hintParts("Install git and check again.", undefined, "a").some((p) => p.route)).toBe(
      false,
    );
  });
});

describe("needsAttention / compactSummary", () => {
  it("treats an unconfigured gateway as optional while an agent works", () => {
    const s: HarnessStatus = {
      ...status(true),
      checks: [{ id: "gateway", label: "g", status: "warn", message: "Not configured." }],
    };
    expect(needsAttention(s)).toBe(false);
    expect(needsAttention({ ...s, anyReady: false })).toBe(true);
    expect(compactSummary(s)).toContain("gateway not configured (optional)");
  });
});
