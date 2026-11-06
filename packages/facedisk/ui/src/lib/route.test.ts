import { describe, expect, it } from "vitest";
import {
  backFor,
  correctedRoute,
  formatRoute,
  listRouteFor,
  parseRoute,
  routeForProject,
  routePid,
  type Route,
} from "./route";

describe("parseRoute", () => {
  it("parses a project overview", () => {
    expect(parseRoute("p/boof")).toEqual({ name: "overview", pid: "boof" });
    expect(parseRoute("p/boof/")).toEqual({ name: "overview", pid: "boof" });
  });

  it("parses tasks and task views", () => {
    expect(parseRoute("p/boof/tasks")).toEqual({ name: "tasks", pid: "boof" });
    expect(parseRoute("p/boof/tasks/fix-login")).toEqual({
      name: "task",
      pid: "boof",
      taskId: "fix-login",
      view: "edit",
    });
    expect(parseRoute("p/boof/tasks/fix-login/changes")).toEqual({
      name: "task",
      pid: "boof",
      taskId: "fix-login",
      view: "changes",
    });
    expect(parseRoute("p/boof/tasks/fix-login/questions")).toEqual({
      name: "task",
      pid: "boof",
      taskId: "fix-login",
      view: "questions",
    });
  });

  it("parses plans and goals without undefined keys", () => {
    const bare = parseRoute("p/boof/plans");
    expect(bare).toEqual({ name: "plans", pid: "boof" });
    expect(bare && "planId" in bare).toBe(false);
    expect(parseRoute("p/boof/plans/repo")).toEqual({
      name: "plans",
      pid: "boof",
      planId: "repo",
    });
    expect(parseRoute("p/boof/plans/repo/migration-lock")).toEqual({
      name: "plans",
      pid: "boof",
      planId: "repo",
      goalId: "migration-lock",
    });
  });

  it("parses settings pages with a fallback", () => {
    expect(parseRoute("p/boof/settings")).toEqual({
      name: "settings",
      pid: "boof",
      page: "project",
    });
    expect(parseRoute("p/boof/settings/keys")).toEqual({
      name: "settings",
      pid: "boof",
      page: "keys",
    });
    expect(parseRoute("p/boof/settings/nope")).toEqual({
      name: "settings",
      pid: "boof",
      page: "project",
    });
  });

  it("parses the inbox", () => {
    expect(parseRoute("inbox")).toEqual({ name: "inbox" });
  });

  it("returns null for empty, unknown and hash input", () => {
    for (const h of ["", "/", "elsewhere", "#/p/boof"]) expect(parseRoute(h)).toBeNull();
  });

  it("rejects over-long paths, empty and dot segments", () => {
    for (const p of [
      "inbox/a",
      "inbox/a/b/c",
      "p/x/tasks/a/b/c/d/e",
      "p//x",
      "//p/x",
      "p/x/../y",
      "p/./x",
      "p/..",
    ])
      expect(parseRoute(p), p).toBeNull();
    expect(parseRoute("p/x/tasks/a/b")).not.toBeNull();
  });

  it("ignores one leading slash", () => {
    expect(parseRoute("/p/boof/")).toEqual({ name: "overview", pid: "boof" });
  });

  it("falls back to overview for unknown project sections", () => {
    expect(parseRoute("p/boof/bogus")).toEqual({ name: "overview", pid: "boof" });
  });

  it("decodes segments", () => {
    expect(parseRoute("p/my%20proj/tasks/a%2Fb")).toEqual({
      name: "task",
      pid: "my proj",
      taskId: "a/b",
      view: "edit",
    });
  });

  it("returns null on malformed encoding", () => {
    expect(parseRoute("p/%E0%A4%A")).toBeNull();
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
    { name: "task", pid: "boof", taskId: "a?b#c%d", view: "edit" },
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

  it("never emits %2F (a proxy may decode it and move the base)", () => {
    for (const r of routes.filter((r) => !JSON.stringify(r).includes("a/b")))
      expect(formatRoute(r)).not.toMatch(/%2f/i);
  });

  it("never starts with / or #", () => {
    for (const r of routes) expect(formatRoute(r)).not.toMatch(/^[/#]/);
  });

  it("formats specific shapes", () => {
    expect(formatRoute({ name: "overview", pid: "my proj" })).toBe("p/my%20proj");
    expect(formatRoute({ name: "inbox" })).toBe("inbox");
    expect(formatRoute({ name: "settings", pid: "boof", page: "project" })).toBe("p/boof/settings");
    expect(formatRoute({ name: "task", pid: "boof", taskId: "t", view: "edit" })).toBe(
      "p/boof/tasks/t",
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

describe("routeForProject", () => {
  it("drops the plan and goal ids when switching from a plan", () => {
    const r = routeForProject({ name: "plans", pid: "a", planId: "p1", goalId: "g1" }, "b");
    expect(r).toEqual({ name: "plans", pid: "b" });
    expect("planId" in r).toBe(false);
  });
  it("drops the task id when switching from a task", () => {
    expect(routeForProject({ name: "task", pid: "a", taskId: "t1", view: "changes" }, "b")).toEqual(
      {
        name: "tasks",
        pid: "b",
      },
    );
  });
  it("keeps the settings page", () => {
    expect(routeForProject({ name: "settings", pid: "a", page: "keys" }, "b")).toEqual({
      name: "settings",
      pid: "b",
      page: "keys",
    });
  });
  it("maps the rest to the equivalent screen", () => {
    expect(routeForProject({ name: "overview", pid: "a" }, "b")).toEqual({
      name: "overview",
      pid: "b",
    });
    expect(routeForProject({ name: "tasks", pid: "a" }, "b")).toEqual({ name: "tasks", pid: "b" });
    expect(routeForProject({ name: "inbox" }, "b")).toEqual({ name: "overview", pid: "b" });
    expect(routeForProject(null, "b")).toEqual({ name: "overview", pid: "b" });
  });
});

describe("listRouteFor", () => {
  it("goes from a task or plan to its list", () => {
    expect(listRouteFor({ name: "task", pid: "a", taskId: "t", view: "edit" })).toEqual({
      name: "tasks",
      pid: "a",
    });
    expect(listRouteFor({ name: "plans", pid: "a", planId: "p" })).toEqual({
      name: "plans",
      pid: "a",
    });
  });
  it("returns other routes as they are", () => {
    for (const r of [
      { name: "overview", pid: "a" },
      { name: "tasks", pid: "a" },
      { name: "settings", pid: "a", page: "keys" },
    ] as Route[])
      expect(listRouteFor(r)).toBe(r);
  });
});

describe("correctedRoute", () => {
  it("waits for the facts", () => {
    expect(correctedRoute({ name: "tasks", pid: "x" }, null, "sel")).toBeNull();
    expect(correctedRoute({ name: "tasks", pid: "x" }, ["sel"], null)).toBeNull();
  });
  it("sends no route to the selected project's overview", () => {
    expect(correctedRoute(null, ["sel"], "sel")).toEqual({ name: "overview", pid: "sel" });
  });
  it("leaves the inbox and known projects alone", () => {
    expect(correctedRoute({ name: "inbox" }, ["sel"], "sel")).toBeNull();
    expect(correctedRoute({ name: "tasks", pid: "sel" }, ["sel"], "sel")).toBeNull();
  });
  it("replaces an unknown project with the selected one's list", () => {
    expect(
      correctedRoute({ name: "task", pid: "gone", taskId: "t1", view: "edit" }, ["sel"], "sel"),
    ).toEqual({
      name: "tasks",
      pid: "sel",
    });
  });
});

describe("backFor", () => {
  const tasks: Route = { name: "tasks", pid: "a" };
  it("returns to a plan, the plans list, tasks or the overview of the same project", () => {
    const plan: Route = { name: "plans", pid: "a", planId: "p", goalId: "g" };
    expect(backFor(plan, "a")).toEqual({ route: plan, label: "← Plan" });
    const plans: Route = { name: "plans", pid: "a" };
    expect(backFor(plans, "a")).toEqual({ route: plans, label: "← Plans" });
    expect(backFor(tasks, "a").label).toBe("← Tasks");
    const ov: Route = { name: "overview", pid: "a" };
    expect(backFor(ov, "a")).toEqual({ route: ov, label: "← Overview" });
  });
  it("falls back to the task list", () => {
    for (const prev of [
      { name: "plans", pid: "b", planId: "p" },
      { name: "inbox" },
      { name: "settings", pid: "a", page: "keys" },
      { name: "task", pid: "a", taskId: "t", view: "edit" },
      null,
    ] as (Route | null)[])
      expect(backFor(prev, "a")).toEqual({ route: tasks, label: "← Tasks" });
  });
});
