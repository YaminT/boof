// The import-boundary map read by import-boundaries.test.ts: which folder belongs to which part of
// the planned split (Heart core, Heart server, Runner, Owlish, Facedisk, desktop, the composition
// root), and which imports may cross. Files stay where they are; the map follows the design in
// docs/superpowers/specs/2026-10-30-boof-split-design.md (§5.1, §7). Step 15 of the roadmap turns
// the folder rules into one line per package.
import { basename, dirname, join, normalize } from "node:path";

export type Part =
  | "heart"
  | "owlish"
  | "runner"
  | "heart-server"
  | "facedisk/ui"
  | "facedisk/cli"
  | "bin"
  | "desktop";

/** Which parts a part may import (parts the same file maps to are not checked). */
export const ALLOWED: Record<Part, Part[]> = {
  heart: [],
  owlish: ["heart"],
  runner: ["heart", "owlish"],
  "heart-server": ["heart", "owlish"],
  "facedisk/cli": ["heart", "heart-server"],
  "facedisk/ui": ["heart", "heart-server"], // type-only, see TYPE_ONLY
  bin: ["heart", "owlish", "runner", "heart-server", "facedisk/cli", "facedisk/ui"],
  desktop: ["heart", "owlish", "runner", "heart-server", "facedisk/ui", "bin"],
};

/** Parts whose imports of other parts must all be `import type`/`export type`. */
export const TYPE_ONLY: Part[] = ["facedisk/ui"];

/**
 * Shared subpaths a TYPE_ONLY part (the browser UI) may import as values, with the source file each
 * resolves to. Every entry must be pure: no `node:` or third-party imports, and relative imports
 * only of other entries; import-boundaries.test.ts checks it, so the exception cannot quietly grow
 * a Node dependency into the browser bundle.
 */
export const BROWSER_SAFE: Record<string, string> = {
  "@boof-runner/shared/ids": "packages/shared/src/ids.ts",
};

/**
 * Known debts, each fixed by a named step of the split. An entry that matches no import fails.
 * Empty since M1: no production import crosses a boundary the design does not allow.
 */
export const ALLOW: { file: string; to: Part; fixedBy: string }[] = [];

/** Folders walked for production files. */
export const SOURCE_ROOTS = ["packages/*/src", "packages/web/ui/src", "bin/src"];

const PACKAGE_PART: Record<string, Part> = {
  shared: "heart",
  runner: "runner",
  api: "heart-server",
  mcp: "heart-server",
  web: "heart-server",
  desktop: "desktop",
};

const CLI_COMMANDS = [
  "auth",
  "epic",
  "plan",
  "project",
  "remote",
  "service",
  "task",
  "mcp",
  "ops",
].map((c) => `${c}-cli.ts`);

/** The part a repo-relative file path (forward slashes) belongs to, or undefined outside the map. */
export function partOfFile(file: string): Part | undefined {
  const p = normalize(file).split("\\").join("/");
  // The package barrel only re-exports every part (Owlish files included); it holds no logic to police.
  if (p === "packages/shared/src/index.ts") return undefined;
  if (p.startsWith("packages/web/ui/src/")) return "facedisk/ui";
  if (p.startsWith("packages/shared/src/") && basename(p).startsWith("owlish")) return "owlish";
  const pkg = /^packages\/([^/]+)\/src\//.exec(p)?.[1];
  if (pkg) return PACKAGE_PART[pkg];
  if (p.startsWith("bin/src/")) {
    return dirname(p) === "bin/src" && CLI_COMMANDS.includes(basename(p)) ? "facedisk/cli" : "bin";
  }
  return undefined;
}

/**
 * The part an import specifier reaches: `@boof-runner/<pkg>[/sub]` by package, a relative path by
 * resolving it against the importing file. Third-party and `node:` specifiers give undefined.
 */
export function partOfSpecifier(spec: string, fromFile: string): Part | undefined {
  const pkg = /^@boof-runner\/([^/]+)/.exec(spec)?.[1];
  if (pkg) return PACKAGE_PART[pkg];
  if (!spec.startsWith(".")) return undefined;
  // A `.js` specifier names the `.ts` file.
  const target = join(dirname(fromFile), spec.replace(/\.js$/, ".ts")).split("\\").join("/");
  return partOfFile(target);
}
