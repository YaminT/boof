import { dirname, join, normalize } from "node:path";

export type Package =
  "heart" | "owlish" | "runner" | "heart-server" | "facedisk" | "bin" | "desktop";

/** Which packages a package may import; imports within one package are not checked. */
export const ALLOWED: Record<Package, Package[]> = {
  heart: [],
  owlish: ["heart"],
  runner: ["heart", "owlish"],
  "heart-server": ["heart", "owlish"],
  facedisk: ["heart", "heart-server"],
  bin: ["heart", "owlish", "runner", "heart-server", "facedisk"],
  desktop: ["heart", "owlish", "runner", "heart-server", "facedisk", "bin"],
};

/** Heart imports from Facedisk UI source must be type-only or browser-safe. */
export const BROWSER_SAFE: Record<string, string> = {
  "@boof/heart/ids": "packages/heart/src/ids.ts",
};

/** Known debts; empty since M1. */
export const ALLOW: { file: string; to: Package; fixedBy: string }[] = [];

/** Production source roots, including the two Facedisk subdirectories. */
export const SOURCE_ROOTS = [
  "packages/*/src",
  "packages/facedisk/ui/src",
  "packages/facedisk/cli",
  "bin/src",
];

const PACKAGE_ID: Record<string, Package> = {
  heart: "heart",
  owlish: "owlish",
  runner: "runner",
  "heart-server": "heart-server",
  facedisk: "facedisk",
  desktop: "desktop",
};

/** Workspace directory to its package identity. */
export function packageOfDirectory(directory: string): Package | undefined {
  const p = normalize(directory).split("\\").join("/").replace(/\/$/, "");
  if (p === "bin") return "bin";
  const match = /^packages\/([^/]+)$/.exec(p);
  return match ? PACKAGE_ID[match[1]!] : undefined;
}

/** The package a repo-relative file path belongs to, or undefined outside the map. */
export function partOfFile(file: string): Package | undefined {
  const p = normalize(file).split("\\").join("/");
  if (p.startsWith("bin/src/")) return "bin";
  const match = /^packages\/([^/]+)\//.exec(p);
  return match ? PACKAGE_ID[match[1]!] : undefined;
}

/** Whether a source file belongs to the browser UI part of Facedisk. */
export function isFacediskUiFile(file: string): boolean {
  return normalize(file).split("\\").join("/").startsWith("packages/facedisk/ui/");
}

/** Resolve a workspace package specifier or relative import to its package identity. */
export function partOfSpecifier(spec: string, fromFile: string): Package | undefined {
  const pkg = /^@boof\/([^/]+)/.exec(spec)?.[1];
  if (pkg) return PACKAGE_ID[pkg];
  if (!spec.startsWith(".")) return undefined;
  const target = join(dirname(fromFile), spec.replace(/\.js$/, ".ts")).split("\\").join("/");
  return partOfFile(target);
}

/** Apply the package graph and Facedisk UI's existing browser-safety rule. */
export function isAllowedImport(
  from: Package,
  to: Package,
  file: string,
  specifier: string,
  typeOnly: boolean,
): boolean {
  if (!ALLOWED[from].includes(to)) return false;
  if (!isFacediskUiFile(file) || (to !== "heart" && to !== "heart-server")) return true;
  return typeOnly || specifier in BROWSER_SAFE;
}
