import { describe, expect, it } from "vitest";
import { isSandboxCheckArgv } from "./sandbox-argv.js";

describe("isSandboxCheckArgv", () => {
  it("matches sandbox check and ignores electron flags and the app path", () => {
    expect(isSandboxCheckArgv(["boof-runner", "sandbox", "check"])).toBe(true);
    expect(
      isSandboxCheckArgv([
        "boof-runner",
        "--appimage-extract-and-run",
        "--no-sandbox",
        "--disable-gpu",
        "sandbox",
        "check",
      ]),
    ).toBe(true);
    expect(isSandboxCheckArgv(["electron", "/opt/app", "sandbox", "check"])).toBe(true);
    expect(isSandboxCheckArgv(["electron", "--", "sandbox", "check"])).toBe(true);
  });

  it("does not match the window launch or a different command", () => {
    expect(isSandboxCheckArgv(["boof-runner"])).toBe(false);
    expect(isSandboxCheckArgv(["boof-runner", "--no-sandbox"])).toBe(false);
    expect(isSandboxCheckArgv(["boof-runner", "sandbox"])).toBe(false);
    expect(isSandboxCheckArgv(["boof-runner", "sandbox", "check", "extra"])).toBe(false);
    expect(isSandboxCheckArgv(["boof-runner", "serve"])).toBe(false);
  });
});
