import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectStack, DETECT_MAX_FILE_BYTES } from "./detect-stack.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "boof-stack-"));
  dirs.push(d);
  return d;
};

describe("detectStack", () => {
  it("finds an npm project with a test script", async () => {
    const d = await tmp();
    await writeFile(
      join(d, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" }, devDependencies: { typescript: "5" } }),
    );
    await writeFile(join(d, "package-lock.json"), "{}");
    expect(await detectStack(d)).toEqual({
      detected: ["package.json"],
      stack: "TypeScript, Node.js (npm)",
      testCommand: "npm test",
    });
  });

  it("uses the package manager of the lockfile", async () => {
    const d = await tmp();
    await writeFile(join(d, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    await writeFile(join(d, "pnpm-lock.yaml"), "");
    expect(await detectStack(d)).toMatchObject({
      stack: "Node.js (pnpm)",
      testCommand: "pnpm test",
    });
  });

  it("finds python, rust and go", async () => {
    const py = await tmp();
    await writeFile(join(py, "pyproject.toml"), "[project]\nname='x'\n");
    expect(await detectStack(py)).toMatchObject({ stack: "Python", testCommand: "pytest" });
    const rs = await tmp();
    await writeFile(join(rs, "Cargo.toml"), "[package]\n");
    expect(await detectStack(rs)).toMatchObject({
      stack: "Rust (cargo)",
      testCommand: "cargo test",
    });
    const go = await tmp();
    await writeFile(join(go, "go.mod"), "module x\n");
    expect(await detectStack(go)).toMatchObject({ stack: "Go", testCommand: "go test ./..." });
  });

  it("reports nothing for an empty directory or a missing one", async () => {
    const d = await tmp();
    expect(await detectStack(d)).toEqual({ detected: [], stack: "", testCommand: "" });
    expect(await detectStack(join(d, "nope"))).toEqual({
      detected: [],
      stack: "",
      testCommand: "",
    });
  });

  it("ignores a symlink that points outside the project and an oversized package.json", async () => {
    const outside = await tmp();
    await writeFile(join(outside, "Cargo.toml"), "[package]\n");
    const d = await tmp();
    await symlink(join(outside, "Cargo.toml"), join(d, "Cargo.toml"));
    await writeFile(join(d, "package.json"), "x".repeat(DETECT_MAX_FILE_BYTES + 1));
    await mkdir(join(d, "sub"));
    expect(await detectStack(d)).toEqual({ detected: [], stack: "", testCommand: "" });
  });

  it("sees a lockfile over the size cap (it is only checked for, never read)", async () => {
    const d = await tmp();
    await writeFile(join(d, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    await writeFile(join(d, "pnpm-lock.yaml"), "x".repeat(DETECT_MAX_FILE_BYTES + 1));
    expect(await detectStack(d)).toMatchObject({
      stack: "Node.js (pnpm)",
      testCommand: "pnpm test",
    });
  });

  it("copes with a broken package.json", async () => {
    const d = await tmp();
    await writeFile(join(d, "package.json"), "{oops");
    expect(await detectStack(d)).toMatchObject({ stack: "Node.js (npm)", testCommand: "" });
  });
});
