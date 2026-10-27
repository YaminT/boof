import { describe, expect, it } from "vitest";
import { formatRoute, parseRoute, routePid, type Route } from "./route";

describe("parseRoute", () => {
  it("parses a project overview", () => {
    expect(parseRoute("#/p/boof")).toEqual({ name: "overview", pid: "boof" });
    expect(parseRoute("#/p/boof/")).toEqual({ name: "overview", pid: "boof" });
  });

  it("parses tasks and task views", () => {
    expect(parseRoute("#/p/boof/tasks")).toEqual({ name: "tasks", pid: "boof" });
    expect(parseRoute("#/p/boof/tasks/fix-login")).toEqual({
      name: "task",
      pid: "boof",
      taskId: "fix-login",
      view: "edit",
    });
    expect(parseRoute("#/p/boof/tasks/fix-login/changes")).toEqual({
      name: "task",
      pid: "boof",
      taskId: "fix-login",
      view: "changes",
    });
    expect(parseRoute("#/p/boof/tasks/fix-login/questions")).toEqual({
      name: "task",
      pid: "boof",
      taskId: "fix-login",
      view: "questions",
    });
  });

  it("parses plans and goals without undefined keys", () => {
    const bare = parseRoute("#/p/boof/plans");
    expect(bare).toEqual({ name: "plans", pid: "boof" });
    expect(bare && "planId" in bare).toBe(false);
    expect(parseRoute("#/p/boof/plans/repo")).toEqual({
      name: "plans",
      pid: "boof",
      planId: "repo",
    });
    expect(parseRoute("#/p/boof/plans/repo/migration-lock")).toEqual({
      name: "plans",
      pid: "boof",
      planId: "repo",
      goalId: "migration-lock",
    });
  });

  it("parses settings pages with a fallback", () => {
    expect(parseRoute("#/p/boof/settings")).toEqual({
      name: "settings",
      pid: "boof",
      page: "project",
    });
    expect(parseRoute("#/p/boof/settings/keys")).toEqual({
      name: "settings",
      pid: "boof",
      page: "keys",
    });
    expect(parseRoute("#/p/boof/settings/nope")).toEqual({
      name: "settings",
      pid: "boof",
      page: "project",
    });
  });

  it("parses the inbox", () => {
    expect(parseRoute("#/inbox")).toEqual({ name: "inbox" });
  });

  it("returns null for unknown or empty hashes", () => {
    for (const h of ["", "#", "#/", "#/elsewhere"]) expect(parseRoute(h)).toBeNull();
  });

  it("falls back to overview for unknown project sections", () => {
    expect(parseRoute("#/p/boof/bogus")).toEqual({ name: "overview", pid: "boof" });
  });

  it("decodes segments", () => {
    expect(parseRoute("#/p/my%20proj/tasks/a%2Fb")).toEqual({
      name: "task",
      pid: "my proj",
      taskId: "a/b",
      view: "edit",
    });
  });

  it("returns null on malformed encoding", () => {
    expect(parseRoute("#/p/%E0%A4%A")).toBeNull();
  });
});

describe("formatRoute", () => {
  const routes: Route[] = [
    { name: "overview", pid: "boof" },
    { name: "tasks", pid: "boof" },
    { name: "task", pid: "boof", taskId: "fix-login", view: "edit" },
    { name: "task", pid: "boof", taskId: "fix-login", view: "changes" },
    { name: "task", pid: "boof", taskId: "fix-login", view: "questions" },
    { name: "task", pid: "my proj", taskId: "a/b", view: "edit" },
    { name: "plans", pid: "boof" },
    { name: "plans", pid: "boof", planId: "repo" },
    { name: "plans", pid: "boof", planId: "repo", goalId: "migration-lock" },
    { name: "settings", pid: "boof", page: "project" },
    { name: "settings", pid: "boof", page: "keys" },
    { name: "inbox" },
  ];

  it("round-trips every route", () => {
    for (const r of routes) expect(parseRoute(formatRoute(r))).toEqual(r);
  });

  it("formats specific shapes", () => {
    expect(formatRoute({ name: "overview", pid: "my proj" })).toBe("#/p/my%20proj");
    expect(formatRoute({ name: "inbox" })).toBe("#/inbox");
    expect(formatRoute({ name: "settings", pid: "boof", page: "project" })).toBe(
      "#/p/boof/settings",
    );
    expect(formatRoute({ name: "task", pid: "boof", taskId: "t", view: "edit" })).toBe(
      "#/p/boof/tasks/t",
    );
  });
});

describe("routePid", () => {
  it("returns the project id or null", () => {
    expect(routePid({ name: "inbox" })).toBeNull();
    expect(routePid(null)).toBeNull();
    expect(routePid({ name: "tasks", pid: "boof" })).toBe("boof");
  });
});
