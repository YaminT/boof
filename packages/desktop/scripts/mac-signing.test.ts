import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const config = readFileSync(resolve(__dirname, "../electron-builder.yml"), "utf8");
const macBlock = config.slice(config.indexOf("\nmac:"), config.indexOf("\ndmg:"));

describe("macOS signing config", () => {
  it("ad-hoc signs the app instead of leaving it unsigned", () => {
    expect(macBlock).toMatch(/^ {2}identity: "-"/m);
    expect(macBlock).not.toMatch(/identity: null/);
  });

  it("does not ask for notarization or the hardened runtime", () => {
    expect(macBlock).toMatch(/^ {2}hardenedRuntime: false/m);
    expect(macBlock).not.toMatch(/notarize:\s*true/);
  });
});
