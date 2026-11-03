import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOW,
  ALLOWED,
  BROWSER_SAFE,
  SOURCE_ROOTS,
  TYPE_ONLY,
  partOfFile,
  partOfSpecifier,
  type Part,
} from "./boundaries.js";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "dist", ".tsc-typecheck", "generated"]);
const SOURCE = /\.(ts|tsx|mjs)$/;
const TEST = /\.test\.tsx?$/;

interface Import {
  specifier: string;
  line: number;
  typeOnly: boolean;
}

/** Imports and re-exports (static and `import("x")`) of one source text. */
export function extractImports(text: string): Import[] {
  const found: Import[] = [];
  const lineOf = (index: number) => text.slice(0, index).split("\n").length;
  const code = (index: number) => {
    // Ignore matches inside a comment line.
    const start = text.lastIndexOf("\n", index) + 1;
    return !/^\s*(\/\/|\*|\/\*)/.test(text.slice(start, index + 1));
  };
  const statics = /^[ \t]*(?:import|export)\s+(type\s+)?([^;'"]*?)\bfrom\s+["']([^"']+)["']/gm;
  for (const m of text.matchAll(statics)) {
    const named = /\{([^}]*)\}/.exec(m[2])?.[1];
    const allInline =
      named !== undefined &&
      !/[^\s,{}]/.test(m[2].replace(/\{[^}]*\}/, "")) &&
      named
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .every((s) => s.startsWith("type "));
    found.push({
      specifier: m[3],
      line: lineOf(m.index),
      typeOnly: m[1] !== undefined || allInline,
    });
  }
  for (const m of text.matchAll(/^[ \t]*import\s+["']([^"']+)["']/gm)) {
    found.push({ specifier: m[1], line: lineOf(m.index), typeOnly: false });
  }
  for (const m of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
    if (code(m.index)) found.push({ specifier: m[1], line: lineOf(m.index), typeOnly: false });
  }
  return found;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE.test(name) && !TEST.test(name)) out.push(full);
  }
  return out;
}

function sourceFiles(): string[] {
  const dirs: string[] = [];
  for (const root of SOURCE_ROOTS) {
    if (root.includes("*")) {
      const [head, tail] = root.split("*");
      for (const pkg of readdirSync(join(repo, head))) dirs.push(join(repo, head, pkg, tail));
    } else {
      dirs.push(join(repo, root));
    }
  }
  const files = new Set<string>();
  for (const d of dirs) {
    try {
      for (const f of walk(d)) files.add(relative(repo, f).split("\\").join("/"));
    } catch {
      // A package without the folder.
    }
  }
  return [...files].sort();
}

interface Violation {
  file: string;
  line: number;
  from: Part;
  to: Part;
  specifier: string;
  reason: "edge" | "value-import";
}

function violations(): Violation[] {
  const found: Violation[] = [];
  for (const file of sourceFiles()) {
    const from = partOfFile(file);
    if (!from) continue;
    const text = readFileSync(join(repo, file), "utf8");
    for (const imp of extractImports(text)) {
      const to = partOfSpecifier(imp.specifier, file);
      if (!to || to === from) continue;
      const base = { file, line: imp.line, from, to, specifier: imp.specifier };
      if (!ALLOWED[from].includes(to)) found.push({ ...base, reason: "edge" });
      else if (TYPE_ONLY.includes(from) && !imp.typeOnly && !(imp.specifier in BROWSER_SAFE)) {
        found.push({ ...base, reason: "value-import" });
      }
    }
  }
  return found;
}

const show = (v: Violation) =>
  `${v.file}:${v.line}  ${v.from} → ${v.to}  "${v.specifier}"${v.reason === "value-import" ? "  (must be import type)" : ""}`;

describe("import boundaries", () => {
  it("maps folders to parts", () => {
    expect(partOfFile("packages/shared/src/schema.ts")).toBe("heart");
    expect(partOfFile("packages/shared/src/owlish-client.ts")).toBe("owlish");
    expect(partOfFile("packages/runner/src/engine.ts")).toBe("runner");
    for (const p of ["api", "mcp", "web"]) {
      expect(partOfFile(`packages/${p}/src/x.ts`)).toBe("heart-server");
    }
    expect(partOfFile("packages/web/ui/src/App.tsx")).toBe("facedisk/ui");
    expect(partOfFile("bin/src/project-cli.ts")).toBe("facedisk/cli");
    expect(partOfFile("bin/src/ops-cli.ts")).toBe("facedisk/cli");
    expect(partOfFile("bin/src/headless.ts")).toBe("bin");
    expect(partOfFile("packages/desktop/src/main.ts")).toBe("desktop");
    expect(partOfFile("scripts/x.ts")).toBeUndefined();
  });

  it("maps specifiers and ignores third-party ones", () => {
    expect(partOfSpecifier("@boof-runner/runner", "bin/src/x.ts")).toBe("runner");
    expect(partOfSpecifier("@boof-runner/shared/sub", "bin/src/x.ts")).toBe("heart");
    expect(partOfSpecifier("./scaffold.js", "packages/shared/src/index.ts")).toBe("heart");
    expect(partOfSpecifier("./headless.js", "bin/src/plan-cli.ts")).toBe("bin");
    // The barrel re-exports Owlish files without being a Heart dependency on them.
    expect(partOfFile("packages/shared/src/index.ts")).toBeUndefined();
    expect(partOfFile("packages/shared/src/owlish.ts")).toBe("owlish");
    expect(partOfSpecifier("../../../shared/src/x.js", "packages/api/src/ops/y.ts")).toBe("heart");
    expect(partOfSpecifier("node:fs", "bin/src/x.ts")).toBeUndefined();
    expect(partOfSpecifier("hono", "bin/src/x.ts")).toBeUndefined();
  });

  it("extracts imports, re-exports, dynamic imports and type-only statements", () => {
    const text = [
      `import { a } from "x1";`,
      `import type { B } from "x2";`,
      `import { type C, type D } from "x3";`,
      `import {`,
      `  e,`,
      `} from "x4";`,
      `export * from "x5";`,
      `export type { F } from "x6";`,
      `import "x7";`,
      `const m = await import("x8");`,
      `// import { z } from "ignored";`,
      ` * import("ignored2")`,
    ].join("\n");
    const got = extractImports(text).map((i) => [i.specifier, i.typeOnly]);
    expect(got).toEqual([
      ["x1", false],
      ["x2", true],
      ["x3", true],
      ["x4", false],
      ["x5", false],
      ["x6", true],
      ["x7", false],
      ["x8", false],
    ]);
    expect(extractImports(text).find((i) => i.specifier === "x4")?.line).toBe(4);
  });

  it("walks production files only", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => TEST.test(f))).toBe(false);
    expect(files).toContain("bin/src/boundaries.ts");
    expect(files).toContain("packages/web/ui/src/main.tsx");
  });

  it("has no import outside the allowed edges except the day-one allow-list", () => {
    const unexpected = violations().filter(
      (v) => !ALLOW.some((a) => a.file === v.file && a.to === v.to),
    );
    expect(unexpected.map(show)).toEqual([]);
  });

  it("keeps the browser-safe shared subpaths pure", () => {
    const safeFiles = new Set(Object.values(BROWSER_SAFE));
    expect(safeFiles.size).toBe(Object.keys(BROWSER_SAFE).length);
    for (const [spec, file] of Object.entries(BROWSER_SAFE)) {
      expect(partOfFile(file), spec).toBe("heart");
      const text = readFileSync(join(repo, file), "utf8");
      const bad = extractImports(text)
        .filter((i) => {
          if (!i.specifier.startsWith(".")) return true; // node: and third-party
          const target = join(dirname(file), i.specifier.replace(/\.js$/, ".ts"));
          return !safeFiles.has(target.split("\\").join("/"));
        })
        .map((i) => `${file}:${i.line} "${i.specifier}"`);
      expect(bad, `${spec} must stay free of Node and third-party imports`).toEqual([]);
    }
  });

  it("lets the UI value-import only the browser-safe subpaths", () => {
    const text = (spec: string) => `import { x } from "${spec}";`;
    const ui = "packages/web/ui/src/lib/f.ts";
    const check = (spec: string) => {
      const imp = extractImports(text(spec))[0];
      const to = partOfSpecifier(spec, ui)!;
      return ALLOWED["facedisk/ui"].includes(to) && (imp.typeOnly || spec in BROWSER_SAFE);
    };
    expect(check("@boof-runner/shared/ids")).toBe(true);
    expect(check("@boof-runner/shared/schema")).toBe(false);
    expect(check("@boof-runner/shared")).toBe(false);
  });

  it("has no stale allow-list entry", () => {
    const all = violations();
    const stale = ALLOW.filter((a) => !all.some((v) => v.file === a.file && v.to === a.to));
    expect(stale.map((a) => `${a.file} → ${a.to} (fixed by ${a.fixedBy})`)).toEqual([]);
  });
});
