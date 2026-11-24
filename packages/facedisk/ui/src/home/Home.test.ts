import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Project } from "@boof/heart/schema";
import { homeCards } from "../lib/home.js";
import { HomeLink, Rail } from "../shell/Rail.js";
import { ProjectCard, ProjectCardSkeleton } from "./ProjectCard.js";

const project = {
  id: "demo",
  name: "Demo",
  workingDirectory: "/w/demo",
  paused: false,
  archived: false,
} as Project;
const card = (counts: Record<string, number>, running: string[] = []) =>
  homeCards(
    [project],
    {
      enabled: true,
      budgetExceeded: [],
      projects: [
        {
          id: "demo",
          paused: false,
          running,
          counts,
          plans: { activeTitle: "Launch", goalsDone: 7, goalsTotal: 11 },
          lastActivity: new Date(Date.now() - 5 * 60_000).toISOString(),
        },
      ],
    },
    Date.now(),
  )[0]!;

const render = (c: ReturnType<typeof card>, extra = {}) =>
  renderToStaticMarkup(
    h(ProjectCard, {
      card: c,
      runningTitle: "Fix login",
      paused: false,
      busy: false,
      onTogglePause: () => {},
      ...extra,
    }),
  );

describe("HomeLink", () => {
  it("is a link to the app root with an accessible name", () => {
    const html = renderToStaticMarkup(h(HomeLink));
    expect(html).toContain('href="./"');
    expect(html).toContain('aria-label="Boof home"');
    expect(html).toContain("focus-ring");
  });
  it("heads the rail, above a Home item", () => {
    const html = renderToStaticMarkup(
      h(Rail, {
        active: "home",
        counts: { tasks: 0, plans: 0, inbox: 0 },
        go: () => {},
        projectMenu: null,
        footer: null,
      }),
    );
    expect(html.indexOf('aria-label="Boof home"')).toBeLessThan(html.indexOf(">Home<"));
    expect(html).toContain('aria-current="page"');
  });
});

describe("ProjectCard", () => {
  const html = render(card({ done: 7, running: 1, pending: 2, action: 1 }, ["t1"]));
  it("shows state, progress, plan, running task and activity", () => {
    expect(html).toContain("Needs you: 1");
    expect(html).toContain("7 of 11 tasks done");
    expect(html).toContain("7 of 11 goals done");
    expect(html).toContain("Plan: Launch");
    expect(html).toContain("Running now: Fix login");
    expect(html).toContain("active 5m ago");
    expect(html).toContain('aria-valuenow="64"');
  });
  it("links the name to the project and labels the icon buttons", () => {
    expect(html).toContain('href="p/demo"');
    expect(html).toContain('aria-label="Open Demo"');
    expect(html).toContain('aria-label="Pause Demo"');
    expect(html).toContain('aria-label="New plan in Demo"');
    expect(html).toContain('href="p/demo/plans/new"');
  });
  it("never nests a button in a link", () => {
    expect(html).not.toMatch(/<a[^>]*>(?:(?!<\/a>).)*<button/s);
  });
  it("offers Resume when paused and copes with no tasks", () => {
    const idle = render(card({}), { paused: true });
    expect(idle).toContain('aria-label="Resume Demo"');
    expect(idle).toContain("No tasks yet");
    expect(idle).not.toContain("Running now");
  });
  it("has a skeleton of the same height", () => {
    expect(renderToStaticMarkup(h(ProjectCardSkeleton))).toContain("min-h-[176px]");
    expect(html).toContain("min-h-[176px]");
  });
});

describe("ProjectCard before the overview arrives", () => {
  it("shows the project with a progress placeholder, not a bare skeleton", () => {
    const html = render(card({}), { progressPending: true });
    expect(html).toContain("Demo");
    expect(html).toContain('data-testid="card-progress-pending"');
    expect(html).toContain("Loading…");
    expect(html).not.toContain("No tasks yet");
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain('aria-label="Pause Demo"');
  });
});
