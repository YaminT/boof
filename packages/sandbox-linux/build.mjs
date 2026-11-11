import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "boof-sandbox.c");
const outDir = join(here, "dist");
const out = join(outDir, "boof-sandbox");

if (process.platform !== "linux") {
  console.log("boof-sandbox: not Linux; not building the helper");
  process.exit(0);
}

const cc = process.env.CC || "cc";
const found = spawnSync("sh", ["-c", 'command -v "$1"', "sh", cc], { encoding: "utf8" });
if (found.status !== 0) {
  console.log(`boof-sandbox: compiler not found (${cc}); the sandbox is unavailable`);
  process.exit(0);
}

// Release builds set CC=musl-gcc and BOOF_SANDBOX_STATIC=1. A dynamic `cc` build is the
// checkout default: it links the libc the tests and a source install are already running.
const staticLink = process.env.BOOF_SANDBOX_STATIC === "1" || basename(cc) === "musl-gcc";

mkdirSync(outDir, { recursive: true });
const args = ["-O2", "-Wall", "-Wextra", "-Werror"];
if (staticLink) {
  args.push("-static");
  // musl ships no kernel UAPI. linux/*.h and asm/*.h come after musl's own headers.
  args.push("-idirafter", "/usr/include");
  const multi = spawnSync("gcc", ["-print-multiarch"], { encoding: "utf8" });
  const arch = multi.status === 0 ? multi.stdout.trim() : "";
  if (arch) args.push("-idirafter", join("/usr/include", arch));
}
args.push("-o", out, source);
const result = spawnSync(cc, args, { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
