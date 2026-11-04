import { afterEach, describe, expect, it, vi } from "vitest";
import { blockedByGuard, routeOfPath, setLeaveGuard, staysInSettings } from "./leave-guard.js";

afterEach(() => setLeaveGuard(null));

describe("leave guard", () => {
  it("lets everything through without a guard", () => {
    const proceed = vi.fn();
    expect(blockedByGuard({ name: "inbox" }, proceed)).toBe(false);
    expect(proceed).not.toHaveBeenCalled();
  });
  it("hands the target and the continuation to the guard", () => {
    const seen: unknown[] = [];
    setLeaveGuard((to, proceed) => {
      seen.push(to);
      proceed();
      return true;
    });
    const proceed = vi.fn();
    expect(blockedByGuard({ name: "inbox" }, proceed)).toBe(true);
    expect(seen).toEqual([{ name: "inbox" }]);
    expect(proceed).toHaveBeenCalledOnce();
  });
  it("settings pages of the same project are not a departure", () => {
    expect(staysInSettings({ name: "settings", pid: "a", page: "keys" }, "a")).toBe(true);
    expect(staysInSettings({ name: "settings", pid: "b", page: "keys" }, "a")).toBe(false);
    expect(staysInSettings({ name: "tasks", pid: "a" }, "a")).toBe(false);
    expect(staysInSettings(null, "a")).toBe(false);
  });
  it("reads a route from an app path", () => {
    expect(routeOfPath("p/a/tasks")).toEqual({ name: "tasks", pid: "a" });
  });
});
