// The import-boundary map read by import-boundaries.test.ts: which folder belongs to which part of
// the planned split (Heart core, Heart server, Runner, Owlish, Facedisk, desktop, the composition
// root), and which imports may cross. Files stay where they are; the map follows the design in
// docs/superpowers/specs/2026-10-30-boof-split-design.md (§5.1, §7). Step 15 of the roadmap turns
// the folder rules into one line per package.
import { dirname, join, normalize } from "node:path";

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
 * Heart subpaths a TYPE_ONLY part (the browser UI) may import as values, with the source file each
 * resolves to. Every entry must be pure: no `node:` or third-party imports, and relative imports
 * only of other entries; import-boundaries.test.ts checks it, so the exception cannot quietly grow
 * a Node dependency into the browser bundle.
 */
export const BROWSER_SAFE: Record<string, string> = {
  "@boof/heart/ids": "packages/heart/src/ids.ts",
};

/**
 * Known debts, each fixed by a named step of the split. An entry that matches no import fails.
 * Empty since M1: no production import crosses a boundary the design does not allow.
 */
export const ALLOW: { file: string; to: Part; fixedBy: string }[] = [];

/** Folders walked for production files. */
export const SOURCE_ROOTS = [
  "packages/*/src",
  "packages/facedisk/ui/src",
  "packages/facedisk/cli",
  "bin/src",
];

const PACKAGE_PART: Record<string, Part> = {
  heart: "heart",
  owlish: "owlish",
  runner: "runner",
  "heart-server": "heart-server",
  desktop: "desktop",
  facedisk: "facedisk/cli",
};

/** The part a repo-relative file path (forward slashes) belongs to, or undefined outside the map. */
export function partOfFile(file: string): Part | undefined {
  const p = normalize(file).split("\\").join("/");
  if (p.startsWith("packages/facedisk/ui/src/")) return "facedisk/ui";
  if (p.startsWith("packages/facedisk/cli/")) return "facedisk/cli";
  const pkg = /^packages\/([^/]+)\/src\//.exec(p)?.[1];
  if (pkg) return PACKAGE_PART[pkg];
  if (p.startsWith("bin/src/")) return "bin";
  return undefined;
}

/**
 * The part an import specifier reaches: `@boof/<pkg>[/sub]` or a remaining transitional `@boof-runner/<pkg>` by package, a relative path by
 * resolving it against the importing file. Third-party and `node:` specifiers give undefined.
 */
export function partOfSpecifier(spec: string, fromFile: string): Part | undefined {
  const pkg = /^@boof(?:-runner)?\/([^/]+)/.exec(spec)?.[1];
  if (pkg) return PACKAGE_PART[pkg];
  if (!spec.startsWith(".")) return undefined;
  // A `.js` specifier names the `.ts` file.
  const target = join(dirname(fromFile), spec.replace(/\.js$/, ".ts")).split("\\").join("/");
  return partOfFile(target);
}
