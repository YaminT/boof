import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(fileURLToPath(new URL("..", import.meta.url)));
const app = join(desktop, "build", "app");
const main = join(app, "main.js");
if (!existsSync(main) || !existsSync(join(desktop, "dist", "main.js"))) {
  throw new Error(`desktop build or staged app is missing (expected ${main} and dist/main.js)`);
}

function walk(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const full = join(path, entry.name);
    return [full, ...(entry.isDirectory() ? walk(full) : [])];
  });
}

for (const path of walk(app)) {
  if (
    /claude-agent-sdk|@anthropic-ai/i.test(path) ||
    /^claude(?:\.exe)?$/i.test(path.split(/[\\/]/).at(-1))
  ) {
    throw new Error(`unexpected Claude Agent SDK path in staged app: ${path}`);
  }
}
for (const path of [main, join(desktop, "dist", "main.js")]) {
  const contents = readFileSync(path, "utf8");
  for (const marker of ["ProcessTransport", "Native CLI binary for", "Anthropic PBC"]) {
    if (contents.includes(marker)) throw new Error(`unexpected SDK marker ${marker} in ${path}`);
  }
}
console.log(`desktop scan passed: ${app}`);
