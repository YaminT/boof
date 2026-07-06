// Assemble a self-contained Electron app directory for electron-builder.
//
// The Electron main is fully bundled by tsup (every runtime dep except electron
// is inlined into dist/main.js), so the packaged app needs no node_modules —
// just the two bundles, a minimal zero-dependency package.json, and the built
// React UI copied alongside (served from disk by serveStatic, hence asar:false).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const distDir = join(desktopDir, "dist");
const uiDistDir = resolve(desktopDir, "..", "web", "ui", "dist");
const appDir = join(desktopDir, "build", "app");

const pkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));

// The released app carries a beta pre-release identifier so the artifact names
// and the GitHub release tag (v<version>) line up: 0.2.0 -> 0.2.0-beta.
const baseVersion = pkg.version ?? "0.0.0";
const appVersion =
  process.env.BOOF_CLAW_APP_VERSION ?? (baseVersion.includes("-") ? baseVersion : `${baseVersion}-beta`);

function need(path, hint) {
  if (!existsSync(path)) {
    console.error(`stage-app: missing ${path}\n  -> ${hint}`);
    process.exit(1);
  }
}

need(join(distDir, "main.js"), "run `npm run build -w @boof-claw/desktop` first");
need(join(distDir, "preload.js"), "run `npm run build -w @boof-claw/desktop` first");
need(join(uiDistDir, "index.html"), "run `npm run build -w @boof-claw/web` first");

rmSync(appDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

cpSync(join(distDir, "main.js"), join(appDir, "main.js"));
cpSync(join(distDir, "preload.js"), join(appDir, "preload.js"));
cpSync(uiDistDir, join(appDir, "ui"), { recursive: true });

writeFileSync(
  join(appDir, "package.json"),
  JSON.stringify(
    {
      name: "boof-claw",
      productName: "Boof Claw",
      version: appVersion,
      description: "Boof Claw — local-first Agent Task Runner",
      main: "main.js",
      author: "BoofClaw contributors",
      license: "MIT",
    },
    null,
    2,
  ) + "\n",
);

console.log(`stage-app: staged Boof Claw ${appVersion} -> ${appDir}`);
