import { readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOW,
  ALLOWED,
  BROWSER_SAFE,
  SOURCE_ROOTS,
  isAllowedImport,
  packageOfDirectory,
  partOfFile,
  partOfSpecifier,
  type Package,
} from "./boundaries.js";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "dist", ".tsc-typecheck", "generated"]);
const SOURCE = /\.(ts|tsx|mjs)$/;
const TEST = /\.test\.tsx?$/;

function insideGitWorkTree(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repo, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("tracked source git hygiene", () => {
  it.skipIf(!insideGitWorkTree())(
    "does not ignore tracked files under packages or bin (skipped outside a git work tree)",
    () => {
      const tracked = execFileSync("git", ["ls-files", "-z", "--", "packages", "bin"], {
        cwd: repo,
      })
        .toString()
        .split("\0")
        .filter(Boolean);
      const ignored = tracked.filter((file) => {
        try {
          execFileSync("git", ["check-ignore", "--no-index", "-q", "--", file], { cwd: repo });
          return true;
        } catch (error) {
          if ((error as { status?: number }).status === 1) return false;
          throw error;
        }
      });
      expect(ignored, `tracked source files ignored by git:\n${ignored.join("\n")}`).toEqual([]);
    },
  );
});

async function workspaceDirs(): Promise<string[]> {
  const root = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
    workspaces: string[];
  };
  const dirs: string[] = [];
  for (const pattern of root.workspaces) {
    if (pattern.endsWith("/*")) {
      const base = pattern.slice(0, -2);
      for (const entry of readdirSync(join(repo, base), { withFileTypes: true })) {
        const rel = join(base, entry.name);
        if (entry.isDirectory()) {
          try {
            readFileSync(join(repo, rel, "package.json"));
            dirs.push(rel);
          } catch {
            // Not a workspace package directory.
          }
        }
      }
    } else dirs.push(pattern);
  }
  return dirs.sort();
}

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
  const statics = /\b(?:import|export)\s+(type\s+)?([^;'"]*?)\bfrom\s+["']([^"']+)["']/g;
  for (const m of text.matchAll(statics)) {
    if (!code(m.index)) continue;
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
  for (const m of text.matchAll(/\bimport\s+["']([^"']+)["']/g)) {
    if (code(m.index)) found.push({ specifier: m[1], line: lineOf(m.index), typeOnly: false });
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
  from: Package;
  to: Package;
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
      if (!to) continue;
      const base = { file, line: imp.line, from, to, specifier: imp.specifier };
      if (!isAllowedImport(from, to, file, imp.specifier, imp.typeOnly)) {
        const reason =
          file.startsWith("packages/facedisk/ui/") &&
          (to === "heart" || to === "heart-server") &&
          !imp.typeOnly &&
          !(imp.specifier in BROWSER_SAFE)
            ? "value-import"
            : "edge";
        found.push({ ...base, reason });
      }
    }
  }
  return found;
}

const show = (v: Violation) =>
  `${v.file}:${v.line}  ${v.from} → ${v.to}  "${v.specifier}"${v.reason === "value-import" ? "  (must be import type)" : ""}`;

describe("import boundaries", () => {
  it("maps every workspace directory to its package identity", async () => {
    const dirs = await workspaceDirs();
    for (const dir of dirs) expect(packageOfDirectory(dir), dir).toBeDefined();
    expect(dirs.map((dir) => [dir, packageOfDirectory(dir)])).toEqual(
      expect.arrayContaining([
        ["packages/heart", "heart"],
        ["packages/owlish", "owlish"],
        ["packages/runner", "runner"],
        ["packages/heart-server", "heart-server"],
        ["packages/facedisk", "facedisk"],
        ["packages/desktop", "desktop"],
        ["bin", "bin"],
      ]),
    );
    expect(partOfFile("packages/heart/src/schema.ts")).toBe("heart");
    expect(partOfFile("packages/owlish/src/owlish.ts")).toBe("owlish");
    expect(partOfFile("packages/runner/src/engine.ts")).toBe("runner");
    expect(partOfFile("packages/heart-server/src/api/x.ts")).toBe("heart-server");
    expect(partOfFile("packages/heart-server/src/mcp/x.ts")).toBe("heart-server");
    expect(partOfFile("packages/heart-server/src/server/x.ts")).toBe("heart-server");
    expect(partOfFile("packages/facedisk/ui/src/App.tsx")).toBe("facedisk");
    expect(partOfFile("packages/facedisk/cli/auth-cli.ts")).toBe("facedisk");
    expect(partOfFile("packages/facedisk/cli/ops-cli.ts")).toBe("facedisk");
    expect(partOfFile("bin/src/project-cli.ts")).toBe("bin");
    expect(partOfFile("bin/src/headless.ts")).toBe("bin");
    expect(partOfFile("packages/desktop/src/main.ts")).toBe("desktop");
    expect(partOfFile("scripts/x.ts")).toBeUndefined();
  });

  it("maps specifiers and ignores third-party ones", () => {
    expect(partOfSpecifier("@boof/runner", "bin/src/x.ts")).toBe("runner");
    expect(partOfSpecifier("@boof/heart/sub", "bin/src/x.ts")).toBe("heart");
    expect(partOfSpecifier("./scaffold.js", "packages/heart/src/index.ts")).toBe("heart");
    expect(partOfSpecifier("./headless.js", "bin/src/plan-cli.ts")).toBe("bin");
    expect(partOfSpecifier("@boof/owlish", "bin/src/x.ts")).toBe("owlish");
    expect(partOfSpecifier("@boof/heart", "bin/src/x.ts")).toBe("heart");
    expect(partOfSpecifier("@boof/boof", "packages/heart/src/x.ts")).toBe("bin");
    expect(partOfSpecifier("@boof/boof/boot", "packages/desktop/src/x.ts")).toBe("bin");
    expect(readFileSync(join(repo, "packages/heart/src/index.ts"), "utf8")).not.toMatch(/owlish/);
    expect(
      partOfSpecifier("../../../../heart/src/x.js", "packages/heart-server/src/api/ops/y.ts"),
    ).toBe("heart");
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

  it("finds multiple imports and exports on one line", () => {
    expect(
      extractImports('import { a } from "x1"; export { b } from "x2"; const c = import("x3");').map(
        (i) => i.specifier,
      ),
    ).toEqual(["x1", "x2", "x3"]);
  });

  it("walks production files only", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => TEST.test(f))).toBe(false);
    expect(files).toContain("bin/src/boundaries.ts");
    expect(files).toContain("packages/facedisk/ui/src/main.tsx");
  });

  it("has no import outside the allowed edges except the day-one allow-list", () => {
    expect(ALLOW).toEqual([]);
    const unexpected = violations().filter(
      (v) => !ALLOW.some((a) => a.file === v.file && a.to === v.to),
    );
    expect(unexpected.map(show)).toEqual([]);
  });

  it("keeps the browser-safe Heart subpaths pure", () => {
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

  it("enforces every declared package edge and representative forbidden edges", () => {
    for (const [from, targets] of Object.entries(ALLOWED) as [Package, Package[]][]) {
      for (const to of targets) {
        const file =
          from === "bin"
            ? "bin/src/x.ts"
            : from === "facedisk"
              ? "packages/facedisk/cli/x.ts"
              : `packages/${from}/src/x.ts`;
        const specifier = to === "bin" ? "@boof/boof" : `@boof/${to}`;
        expect(isAllowedImport(from, to, file, specifier, false), `${from} -> ${to}`).toBe(true);
      }
    }
    expect(
      isAllowedImport(
        "heart",
        "heart-server",
        "packages/heart/src/x.ts",
        "@boof/heart-server",
        false,
      ),
    ).toBe(false);
    expect(
      isAllowedImport("heart", "facedisk", "packages/heart/src/x.ts", "@boof/facedisk", false),
    ).toBe(false);
    expect(
      isAllowedImport(
        "runner",
        "heart-server",
        "packages/runner/src/x.ts",
        "@boof/heart-server",
        false,
      ),
    ).toBe(false);
    expect(
      isAllowedImport(
        "facedisk",
        "heart",
        "packages/facedisk/ui/src/x.ts",
        "@boof/heart/schema",
        false,
      ),
    ).toBe(false);
  });

  it("lets the UI value-import only the browser-safe subpaths", () => {
    const text = (spec: string) => `import { x } from "${spec}";`;
    const ui = "packages/facedisk/ui/src/lib/f.ts";
    const check = (spec: string) => {
      const imp = extractImports(text(spec))[0];
      const to = partOfSpecifier(spec, ui)!;
      return isAllowedImport("facedisk", to, ui, spec, imp.typeOnly);
    };
    expect(check("@boof/heart/ids")).toBe(true);
    expect(check("@boof/heart/schema")).toBe(false);
    expect(check("@boof/heart")).toBe(false);
  });

  it("keeps Facedisk UI and CLI boundaries inside the folded package", () => {
    const ui = "packages/facedisk/ui/src/x.ts";
    const cli = "packages/facedisk/cli/x.ts";
    expect(isAllowedImport("facedisk", "facedisk", ui, "../../cli/service-cli.js", false)).toBe(
      false,
    );
    expect(isAllowedImport("facedisk", "facedisk", ui, "@boof/facedisk/cli/x.js", false)).toBe(
      false,
    );
    expect(isAllowedImport("facedisk", "facedisk", ui, "../../cli/service-cli.js", true)).toBe(
      true,
    );
    expect(isAllowedImport("facedisk", "facedisk", cli, "../ui/src/App.js", false)).toBe(false);
    expect(isAllowedImport("facedisk", "facedisk", cli, "../ui/src/App.js", true)).toBe(false);
    expect(isAllowedImport("facedisk", "bin", "bin/src/x.ts", "@boof/desktop", false)).toBe(false);
    expect(isAllowedImport("heart", "bin", "packages/heart/src/x.ts", "@boof/boof", false)).toBe(
      false,
    );
    expect(
      isAllowedImport("desktop", "bin", "packages/desktop/src/x.ts", "@boof/boof/boot", false),
    ).toBe(true);
  });

  it("has no stale allow-list entry", () => {
    const all = violations();
    const stale = ALLOW.filter((a) => !all.some((v) => v.file === a.file && v.to === a.to));
    expect(stale.map((a) => `${a.file} → ${a.to} (fixed by ${a.fixedBy})`)).toEqual([]);
  });
});
