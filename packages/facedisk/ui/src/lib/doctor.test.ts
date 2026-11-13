import { describe, expect, it } from "vitest";
import type { DoctorCheck, HarnessStatus } from "../api-types.js";
import { continueRoute, fixRoute, gateOf, reachableWhileBlocked, summarize } from "./doctor.js";

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
