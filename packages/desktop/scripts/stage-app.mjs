// Assemble a self-contained Electron app directory for electron-builder.
//
// The Electron main is fully bundled by tsup (every runtime dep except electron
// is inlined into dist/main.js), so the packaged app needs no node_modules —
// just the two bundles, a minimal zero-dependency package.json, and the built
// React UI copied alongside (served from disk by serveStatic, hence asar:false).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyLinuxSandboxHelper } from "./stage-sandbox.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const distDir = join(desktopDir, "dist");
const uiDistDir = resolve(desktopDir, "..", "facedisk", "ui", "dist");
const appDir = join(desktopDir, "build", "app");

const pkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));

// The release workflow sets BOOF_RUNNER_APP_VERSION from the tag (scripts/release-version.sh);
// a local build stages package.json's version as is.
const baseVersion = pkg.version ?? "0.0.0";
const appVersion = process.env.BOOF_RUNNER_APP_VERSION ?? baseVersion;

function need(path, hint) {
  if (!existsSync(path)) {
    console.error(`stage-app: missing ${path}\n  -> ${hint}`);
    process.exit(1);
  }
}

need(join(distDir, "main.js"), "run `npm run build -w @boof/desktop` first");
need(join(distDir, "preload.js"), "run `npm run build -w @boof/desktop` first");
need(join(uiDistDir, "index.html"), "run `npm run build -w @boof/facedisk` first");

const sandboxHelper = resolve(desktopDir, "..", "sandbox-linux", "dist", "boof-sandbox");
if (process.platform === "linux" && !existsSync(sandboxHelper)) {
  console.error(
    `stage-app: missing ${sandboxHelper}\n  -> run \`node packages/sandbox-linux/build.mjs\` first`,
  );
  process.exit(1);
}

rmSync(appDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

cpSync(join(distDir, "main.js"), join(appDir, "main.js"));
cpSync(join(distDir, "preload.js"), join(appDir, "preload.js"));
cpSync(uiDistDir, join(appDir, "ui"), { recursive: true });
const stagedHelper = copyLinuxSandboxHelper({ helper: sandboxHelper, appDir });
if (stagedHelper) console.log(`stage-app: sandbox helper -> ${stagedHelper}`);

writeFileSync(
  join(appDir, "package.json"),
  JSON.stringify(
    {
      name: "boof-runner",
      productName: "Boof Runner",
      desktopName: "com.boofrunner.desktop",
      version: appVersion,
      description: "Boof Runner — local-first Agent Task Runner",
      main: "main.js",
      author: "BoofRunner contributors",
      license: "MIT",
    },
    null,
    2,
  ) + "\n",
);

console.log(`stage-app: staged Boof Runner ${appVersion} -> ${appDir}`);
