import { describe, expect, it } from "vitest";
import {
  appPathOf,
  basePath,
  isPlainLeftClick,
  legacyHashTarget,
  locationKey,
  routeFromLocation,
} from "./location";

describe("basePath", () => {
  it("returns the base pathname ending in a slash", () => {
    expect(basePath("https://h/boof/")).toBe("/boof/");
    expect(basePath("http://127.0.0.1:4319/")).toBe("/");
  });
});

describe("routeFromLocation", () => {
  it("reads the route under the base", () => {
    expect(routeFromLocation("/boof/p/x/tasks", "/boof/")).toEqual({ name: "tasks", pid: "x" });
    expect(routeFromLocation("/boof/", "/boof/")).toBeNull();
    expect(routeFromLocation("/boof/index.html", "/boof/")).toBeNull();
    expect(routeFromLocation("/other/p/x", "/boof/")).toBeNull();
    expect(routeFromLocation("/p/x", "/")).toEqual({ name: "overview", pid: "x" });
  });
});

describe("legacyHashTarget", () => {
  it("maps legacy hashes to app-relative paths", () => {
    expect(legacyHashTarget("#/p/boof/tasks/t1/changes")).toBe("p/boof/tasks/t1/changes");
    expect(legacyHashTarget("#/inbox")).toBe("inbox");
    expect(legacyHashTarget("#/p/my%20proj")).toBe("p/my%20proj");
    expect(legacyHashTarget("#/")).toBe("./");
    expect(legacyHashTarget("#/elsewhere")).toBe("./");
    expect(legacyHashTarget("")).toBeNull();
    expect(legacyHashTarget("#section")).toBeNull();
  });
  it("never yields a path that leaves the base", () => {
    for (const h of ["#//p/x", "#///p/x", "#///evil.com", "#/p/x/../../..", "#/p/../x", "#/p/x/"]) {
      const t = legacyHashTarget(h);
      expect(t, h).not.toBeNull();
      expect(t, h).not.toMatch(/^\/|(^|\/)\.\.(\/|$)/);
    }
    expect(legacyHashTarget("#///evil.com")).toBe("./");
    expect(legacyHashTarget("#/p/x/")).toBe("p/x");
  });
});

describe("appPathOf", () => {
  const base = "https://h/boof/";
  it("returns the path for in-app route links", () => {
    expect(appPathOf("https://h/boof/p/x/tasks", base)).toBe("p/x/tasks");
    expect(appPathOf("https://h/boof/p/x/tasks/a%2Fb", base)).toBe("p/x/tasks/a%2Fb");
  });
  it("leaves everything else to the browser", () => {
    expect(appPathOf("https://other/boof/p/x", base)).toBeNull();
    expect(appPathOf("https://h/other/p/x", base)).toBeNull();
    expect(
      appPathOf("https://h/boof/api/v1/projects/x/tasks/t/attachments/a.png", base),
    ).toBeNull();
    expect(appPathOf("https://h/boof/p/x#frag", base)).toBeNull();
  });
});

describe("isPlainLeftClick", () => {
  const e = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
  };
  it("accepts only an unmodified left click", () => {
    expect(isPlainLeftClick(e)).toBe(true);
    for (const k of ["metaKey", "ctrlKey", "shiftKey", "altKey", "defaultPrevented"] as const)
      expect(isPlainLeftClick({ ...e, [k]: true })).toBe(false);
    expect(isPlainLeftClick({ ...e, button: 1 })).toBe(false);
  });
});

describe("locationKey", () => {
  it("includes the query, so a query-only change is a different place", () => {
    const base = "https://h/boof/";
    expect(locationKey("p/x/tasks", base)).toBe("/boof/p/x/tasks");
    expect(locationKey("p/x/tasks?state=done", base)).toBe("/boof/p/x/tasks?state=done");
  });
});
