import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { smokeCommand } from "./desktop-smoke-launch.mjs";

const appImage = "/tmp/Boof Runner-0.4.0-linux-x86_64.AppImage";

describe("desktop smoke launch", () => {
  it("starts the Linux AppImage with extract-and-run", () => {
    expect(
      smokeCommand({
        launch: "appimage",
        appImage,
        electronBin: "/electron",
        stagedApp: "/staged",
        userData: "/tmp/user-data",
      }),
    ).toEqual({
      command: appImage,
      args: [
        "--appimage-extract-and-run",
        "--user-data-dir=/tmp/user-data",
        "--no-sandbox",
        "--disable-gpu",
        "--in-process-gpu",
        "--no-zygote",
      ],
    });
  });

  it("starts the staged app on the other systems", () => {
    expect(
      smokeCommand({
        launch: "staged",
        electronBin: "/electron",
        stagedApp: "/staged",
        userData: "/tmp/user-data",
      }),
    ).toEqual({
      command: "/electron",
      args: ["--user-data-dir=/tmp/user-data", "/staged"],
    });
    expect(
      smokeCommand({
        electronBin: "/electron",
        stagedApp: "/staged",
        userData: "/tmp/user-data",
      }).command,
    ).toBe("/electron");
  });

  it("does not select Chromium's basic password store", () => {
    const launched = smokeCommand({
      launch: "appimage",
      appImage,
      stagedApp: "/staged",
      userData: "/tmp/user-data",
    });
    expect(launched.args.join(" ")).not.toContain("password-store");
  });

  it("refuses a launch mode it does not know", () => {
    expect(() =>
      smokeCommand({
        launch: "deb",
        electronBin: "/electron",
        stagedApp: "/staged",
        userData: "/tmp/user-data",
      }),
    ).toThrow(/unknown smoke launch/);
  });
});

describe("linux AppImage release config", () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const read = (rel: string) => readFile(resolve(repo, rel), "utf8");

  it("builds one x64 AppImage under the shared artifact name", async () => {
    const yml = await read("packages/desktop/electron-builder.yml");
    const linux = yml.slice(yml.indexOf("\nlinux:"), yml.indexOf("\nartifactName:"));
    expect(linux).toContain("target: AppImage");
    expect(linux).toContain("arch: [x64]");
    expect(linux).toContain("syncDesktopName: true");
    expect(linux).not.toContain("arm64");
    expect(linux).not.toContain("artifactName");
    const stage = await read("packages/desktop/scripts/stage-app.mjs");
    expect(stage).toContain('desktopName: "com.boofrunner.desktop"');
    expect(yml).toContain("artifactName: ${productName}-${version}-${os}-${arch}.${ext}");
  });

  it("release.yml uploads the AppImage from the Linux leg", async () => {
    const yml = await read(".github/workflows/release.yml");
    expect(yml).toContain("os: ubuntu-latest");
    expect(yml).toContain("name: Linux");
    expect(yml).toContain("packages/desktop/build/release/*.AppImage");
    expect(yml).toContain("export APPIMAGE_EXTRACT_AND_RUN=1");
    expect(yml).toContain("electron-builder --linux --publish never");
    expect(yml).toContain("CC=musl-gcc BOOF_SANDBOX_STATIC=1");
    expect(yml).toContain("statically linked");
    const names = [...yml.matchAll(/name: (macOS|Windows|Linux)/g)].map((match) => match[1]);
    expect(names).toEqual(["macOS", "Windows", "Linux"]);
  });

  it("the Linux smoke leg runs the AppImage under xvfb and expects the keyring fallback", async () => {
    const workflow = await read(".github/workflows/desktop-smoke.yml");
    const launcher = await read("packages/desktop/scripts/desktop-smoke-launch.mjs");
    const script = await read("packages/desktop/scripts/desktop-smoke.mjs");
    const lifecycle = await read("packages/desktop/src/lifecycle.ts");
    const main = await read("packages/desktop/src/main.ts");
    const fallback =
      "safeStorage unavailable: the desktop UI uses a browser session set by the app";
    expect(workflow).toContain("xvfb-run -a node packages/desktop/scripts/desktop-smoke.mjs");
    expect(workflow).toContain("CC=musl-gcc BOOF_SANDBOX_STATIC=1");
    expect(workflow).toContain('xvfb-run -a "${images[0]}" --appimage-extract-and-run');
    expect(workflow).toContain("sandbox check");
    expect(workflow).toContain("launch: appimage");
    expect(workflow).toContain("BOOF_SMOKE_EXPECT_KEYRING_FALLBACK=1");
    expect(launcher).toContain("--appimage-extract-and-run");
    expect(script).toContain(fallback);
    expect(lifecycle).toContain(fallback);
    expect(main).toContain("desktopKeyringAvailable");
    expect(main).toContain("isSandboxCheckArgv");
    expect(main).not.toContain("password-store");
    expect(main).not.toContain("setUsePlainTextEncryption");
  });
});
