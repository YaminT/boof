import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("..", import.meta.url));
const FORBIDDEN = [
  "BOOF_DEV_FAKE",
  "scripted-concierge",
  "Literal markup stays literal",
  "dev-fake-concierge",
  "dev-serve",
];

describe("the production CLI bundle", () => {
  it("holds no fake assistant and no switch for one", () => {
    // Build into a scratch dir so the test does not touch bin/dist.
    const out = mkOut();
    try {
      execFileSync("npx", ["tsup", "--out-dir", out, "--silent"], {
        cwd: bin,
        stdio: "pipe",
        // Windows resolves npx.cmd only through a shell.
        shell: process.platform === "win32",
      });
      const files = readdirSync(out).filter((f) => f.endsWith(".js"));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const text = readFileSync(join(out, file), "utf8");
        for (const word of FORBIDDEN) expect(text, `${file} contains ${word}`).not.toContain(word);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});

function mkOut(): string {
  return mkdtempSync(join(tmpdir(), "boof-bin-dist-"));
}
