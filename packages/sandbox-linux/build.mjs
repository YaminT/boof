import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
  console.log(`boof-sandbox: compiler not found (${cc}); not building the helper`);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const result = spawnSync(cc, ["-O2", "-Wall", "-Wextra", "-Werror", "-o", out, source], {
  stdio: "inherit",
});
process.exit(result.status === null ? 1 : result.status);
