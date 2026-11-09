import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registry } from "../api/index.js";
import { OP_COVERAGE } from "../../../facedisk/ui/src/op-coverage.js";

const UI_SRC = join(dirname(fileURLToPath(import.meta.url)), "../../../facedisk/ui/src");

/** Every non-test source file of the UI, by base name (api.ts and the manifest itself left out). */
function uiSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) {
        const base = e.name.replace(/\.tsx?$/, "");
        if (base !== "api" && base !== "op-coverage") out.set(base, readFileSync(p, "utf8"));
      }
    }
  };
  walk(UI_SRC);
  return out;
}

const apiMethods = (): string[] => {
  const src = readFileSync(join(UI_SRC, "api.ts"), "utf8");
  return [...src.slice(src.indexOf("export const api = {")).matchAll(/^ {2}(\w+):/gm)].map(
    (m) => m[1],
  );
};

describe("UI coverage of the operations", () => {
  it("names a real api.ts method and screens that really call it", () => {
    const methods = new Set(apiMethods());
    const sources = uiSources();
    for (const [op, v] of Object.entries(OP_COVERAGE)) {
      if (!("where" in v)) continue;
      const m = /^(\w+)(?: \{[^}]*\})?(?: \([A-Z]+\))? \u2014 ([^(]+?)(?: \(|$)/.exec(v.where);
      expect(
        m,
        `${op}: "${v.where}" is not "<method> \u2014 <Screen, Screen> (note)"`,
      ).not.toBeNull();
      const [, method, screens] = m!;
      expect(methods.has(method), `${op}: api.ts has no ${method}`).toBe(true);
      const call = new RegExp(`\\bapi\\s*\\.\\s*${method}\\b|\\.\\s*${method}\\s*\\(`);
      for (const screen of screens.split(",").map((x) => x.trim())) {
        const text = sources.get(screen);
        expect(text, `${op}: no UI file named ${screen}`).toBeDefined();
        expect(call.test(text!), `${op}: ${screen} never calls ${method}`).toBe(true);
      }
    }
  });

  it("lists no operation as none when its method is called by the UI under another entry", () => {
    // Every api.ts method with a call site belongs to some entry (a stale manifest drops one).
    const named = new Set(
      Object.values(OP_COVERAGE).flatMap((v) => ("where" in v ? [v.where.split(/[ ]/)[0]] : [])),
    );
    const sources = [...uiSources().values()];
    for (const method of apiMethods()) {
      const call = new RegExp(`\\bapi\\s*\\.\\s*${method}\\b|\\.\\s*${method}\\s*\\(`);
      if (sources.some((t) => call.test(t)))
        expect(named.has(method), `${method} is called but unlisted`).toBe(true);
    }
  });

  it("has exactly one entry per registry operation", () => {
    expect(Object.keys(OP_COVERAGE)).toEqual(registry.map((o) => o.name));
  });

  it("gives every entry a non-empty where or none", () => {
    for (const [name, v] of Object.entries(OP_COVERAGE)) {
      const text = "where" in v ? v.where : v.none;
      expect(text.trim().length, name).toBeGreaterThan(10);
    }
  });

  it("lists the operations the UI does not do (adding one is a reviewed decision)", () => {
    const none = Object.entries(OP_COVERAGE)
      .filter(([, v]) => "none" in v)
      .map(([k]) => k);
    expect(none).toMatchInlineSnapshot(`
      [
        "projects.pause",
        "projects.resume",
        "plans.replaceGoals",
        "plans.wait",
        "tasks.wait",
        "epics.get",
        "settings.health",
        "settings.models",
        "runner.overview",
        "n8n.get",
        "n8n.update",
        "n8n.delete",
        "n8n.workflows.list",
        "n8n.workflows.refresh",
      ]
    `);
  });
});
