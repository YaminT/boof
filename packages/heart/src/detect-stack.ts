/**
 * Read-only guess at a project's stack and test command for the plan wizard's "About this
 * project" step. No model, no network: it reads a few well-known files of the project directory,
 * each at most 256 KB, and ignores any that is not a regular file inside that directory.
 */
import { open, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";

export const DETECT_MAX_FILE_BYTES = 256 * 1024;

export interface DetectedStack {
  /** Which known files were found. */
  detected: string[];
  /** Short stack description, e.g. "TypeScript, Node.js (npm)"; empty when nothing was found. */
  stack: string;
  /** Test command, empty when none was found. */
  testCommand: string;
}

/** The file's text, or null when missing, not a regular file, too large, or outside `root`. */
async function readSmall(root: string, name: string): Promise<string | null> {
  try {
    const real = await realpath(join(root, name));
    if (real !== root && !real.startsWith(root + sep)) return null;
    const info = await stat(real);
    if (!info.isFile() || info.size > DETECT_MAX_FILE_BYTES) return null;
    const handle = await open(real, "r");
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** A regular file of any size inside `root` (it is not read, so the size cap does not apply). */
async function exists(root: string, name: string): Promise<boolean> {
  try {
    const real = await realpath(join(root, name));
    if (real !== root && !real.startsWith(root + sep)) return false;
    return (await stat(real)).isFile();
  } catch {
    return false;
  }
}

export async function detectStack(projectDir: string): Promise<DetectedStack> {
  let root: string;
  try {
    root = await realpath(projectDir);
  } catch {
    return { detected: [], stack: "", testCommand: "" };
  }
  const detected: string[] = [];
  const parts: string[] = [];
  let testCommand = "";

  const pkgText = await readSmall(root, "package.json");
  if (pkgText !== null) {
    detected.push("package.json");
    let pkg: {
      scripts?: Record<string, unknown>;
      dependencies?: object;
      devDependencies?: object;
    } = {};
    try {
      const value: unknown = JSON.parse(pkgText);
      if (value && typeof value === "object") pkg = value as typeof pkg;
    } catch {
      // a broken package.json still says "Node.js"
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const manager = (await exists(root, "pnpm-lock.yaml"))
      ? "pnpm"
      : (await exists(root, "yarn.lock"))
        ? "yarn"
        : (await exists(root, "bun.lockb")) || (await exists(root, "bun.lock"))
          ? "bun"
          : "npm";
    if ("typescript" in deps || (await exists(root, "tsconfig.json"))) parts.push("TypeScript");
    parts.push(`Node.js (${manager})`);
    const test = pkg.scripts?.test;
    if (typeof test === "string" && test.trim() !== "") {
      testCommand = manager === "npm" ? "npm test" : `${manager} test`;
    }
  }
  const pyproject = await readSmall(root, "pyproject.toml");
  if (pyproject !== null || (await exists(root, "requirements.txt"))) {
    detected.push(pyproject !== null ? "pyproject.toml" : "requirements.txt");
    parts.push("Python");
    if (!testCommand) testCommand = "pytest";
  }
  if (await exists(root, "Cargo.toml")) {
    detected.push("Cargo.toml");
    parts.push("Rust (cargo)");
    if (!testCommand) testCommand = "cargo test";
  }
  if (await exists(root, "go.mod")) {
    detected.push("go.mod");
    parts.push("Go");
    if (!testCommand) testCommand = "go test ./...";
  }
  return { detected, stack: parts.join(", "), testCommand };
}
