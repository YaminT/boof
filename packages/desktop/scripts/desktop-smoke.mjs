// Start the packaged desktop app and wait until GET /healthz matches the tag version.
// Linux (BOOF_SMOKE_LAUNCH=appimage) runs the built AppImage. Other systems run the
// staged app under Electron. A scratch user-data dir keeps this off the owner's data.
import { appendFile, chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { smokeCommand } from "./desktop-smoke-launch.mjs";

const FALLBACK_WARNING =
  "safeStorage unavailable: the desktop UI uses a browser session set by the app";

const repo = resolve(import.meta.dirname, "../../..");
const stagedApp = join(repo, "packages", "desktop", "build", "app");
const releaseDir = join(repo, "packages", "desktop", "build", "release");
const output = resolve(process.env.BOOF_SMOKE_OUTPUT ?? join(repo, ".desktop-smoke"));
const userData = resolve(process.env.BOOF_SMOKE_USER_DATA ?? join(tmpdir(), "boof-desktop-smoke"));
const dataRoot = join(userData, "data");
const port = Number(process.env.BOOF_RUNNER_PORT ?? "14319");
const expectedVersion = process.env.BOOF_SMOKE_EXPECTED_VERSION?.replace(/^v/, "");
const launch = process.env.BOOF_SMOKE_LAUNCH ?? "staged";
const expectFallback = process.env.BOOF_SMOKE_EXPECT_KEYRING_FALLBACK === "1";
const marker = `--user-data-dir=${userData}`;
const stdoutPath = join(output, "stdout.log");
const stderrPath = join(output, "stderr.log");
const listingPath = join(output, "data-root-listing.txt");

function refuseOwnerData(path) {
  const needle = `${sep}.local${sep}share${sep}boof-runner`;
  if (path.includes(needle)) {
    throw new Error(`refusing to smoke against the boof-runner data directory: ${path}`);
  }
}

async function findAppImage() {
  if (process.env.BOOF_SMOKE_APPIMAGE) return resolve(process.env.BOOF_SMOKE_APPIMAGE);
  let names = [];
  try {
    names = (await readdir(releaseDir)).filter((name) => name.endsWith(".AppImage"));
  } catch (error) {
    throw new Error(`AppImage directory ${releaseDir} is missing (${error.code ?? error.message})`);
  }
  if (names.length !== 1) {
    throw new Error(`expected one AppImage in ${releaseDir}, found ${names.join(", ") || "none"}`);
  }
  return join(releaseDir, names[0]);
}

async function listProcesses() {
  const command =
    process.platform === "win32"
      ? spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
          ],
          { stdio: ["ignore", "pipe", "ignore"] },
        )
      : spawn("ps", ["-eo", "pid=,args="], { stdio: ["ignore", "pipe", "ignore"] });
  let stdout = "";
  command.stdout.setEncoding("utf8");
  command.stdout.on("data", (chunk) => (stdout += chunk));
  await new Promise((done) => command.once("close", done));
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.includes(marker) && !line.includes("desktop-smoke.mjs"));
}

async function writeDataRootListing() {
  const lines = [`data root: ${dataRoot}`];
  async function walk(path, prefix = "") {
    let names;
    try {
      names = await readdir(path);
    } catch (error) {
      lines.push(`${prefix}[${error.code ?? error.message}]`);
      return;
    }
    if (names.length === 0) lines.push(`${prefix}[empty]`);
    for (const name of names.sort()) {
      const childPath = join(path, name);
      let details = "";
      try {
        const info = await stat(childPath);
        details = info.isDirectory() ? "/" : ` (${info.size} bytes)`;
      } catch (error) {
        details = ` [${error.code ?? error.message}]`;
      }
      lines.push(`${prefix}${name}${details}`);
      try {
        if ((await stat(childPath)).isDirectory()) await walk(childPath, `${prefix}  `);
      } catch {
        // the listing is diagnostic
      }
    }
  }
  await walk(dataRoot);
  await writeFile(listingPath, `${lines.join("\n")}\n`);
}

function signal(child, sig) {
  if (child.pid == null) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, sig);
      return;
    } catch {
      // the process group is already gone, or the child was not a group leader
    }
  }
  try {
    child.kill(sig);
  } catch {
    // already exited
  }
}

async function main() {
  refuseOwnerData(userData);
  refuseOwnerData(output);
  if (!expectedVersion) throw new Error("BOOF_SMOKE_EXPECTED_VERSION is required");
  if (Number.isNaN(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${port}`);

  await mkdir(output, { recursive: true });
  await mkdir(userData, { recursive: true });
  const home = process.env.HOME ?? userData;
  const profile = process.env.USERPROFILE ?? userData;
  refuseOwnerData(home);
  await mkdir(home, { recursive: true });
  await mkdir(profile, { recursive: true });
  const runtime = join(output, "runtime");
  if (expectFallback) {
    await mkdir(runtime, { recursive: true });
    await chmod(runtime, 0o700);
  }

  const appImage = launch === "appimage" ? await findAppImage() : undefined;
  if (appImage) await chmod(appImage, 0o755);
  const electronBin = launch === "appimage" ? undefined : (await import("electron")).default;
  const launched = smokeCommand({
    launch,
    appImage,
    electronBin,
    stagedApp,
    userData,
  });

  const childEnv = {
    ...process.env,
    BOOF_RUNNER_PORT: String(port),
    HOME: home,
    USERPROFILE: profile,
  };
  // The Linux leg proves startup with no keyring. Drop the caller's session bus
  // so a developer machine does not hide the fallback behind gnome-keyring.
  if (expectFallback) {
    childEnv.XDG_RUNTIME_DIR = runtime;
    delete childEnv.DBUS_SESSION_BUS_ADDRESS;
    delete childEnv.XDG_CURRENT_DESKTOP;
    delete childEnv.DESKTOP_SESSION;
    delete childEnv.GNOME_KEYRING_CONTROL;
  }

  const child = spawn(launched.command, launched.args, {
    cwd: repo,
    env: childEnv,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let captured = "";
  let logChain = Promise.resolve();
  const capture = (file, chunk) => {
    captured += chunk.toString();
    logChain = logChain.then(() => appendFile(file, chunk));
  };
  child.stdout.on("data", (chunk) => capture(stdoutPath, chunk));
  child.stderr.on("data", (chunk) => capture(stderrPath, chunk));

  let exitInfo;
  const exit = new Promise((done) => {
    child.once("error", (error) => done({ error: String(error) }));
    child.once("exit", (code, signalName) => {
      exitInfo = { code, signal: signalName };
      done(exitInfo);
    });
  });

  async function waitForHealth() {
    const deadline = Date.now() + 60_000;
    let lastError = "no response";
    while (Date.now() < deadline) {
      const result = await Promise.race([exit, delay(0).then(() => null)]);
      if (result) throw new Error(`desktop exited before health check: ${JSON.stringify(result)}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
          signal: AbortSignal.timeout(1500),
        });
        if (response.ok) {
          const health = await response.json();
          if (health.ok !== true) {
            throw new Error(`health response was not ok: ${JSON.stringify(health)}`);
          }
          if (health.version !== expectedVersion) {
            throw new Error(`expected version ${expectedVersion}, got ${health.version}`);
          }
          return;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        if (
          error.message.startsWith("expected version") ||
          error.message.startsWith("health response")
        ) {
          throw error;
        }
        lastError = error.message;
      }
      await delay(500);
    }
    throw new Error(`health endpoint did not become ready within 60 seconds: ${lastError}`);
  }

  let failure;
  try {
    await waitForHealth();
    const root = await stat(dataRoot);
    if (!root.isDirectory()) throw new Error(`data root is not a directory: ${dataRoot}`);
    JSON.parse(await readFile(join(dataRoot, "settings.json"), "utf8"));
    if (process.platform === "win32") {
      await logChain;
      const stderr = await readFile(stderrPath, "utf8").catch(() => "");
      if (/could not restrict the access list|ACL step/i.test(stderr)) {
        throw new Error("desktop reported a Windows ACL setup failure; see stderr.log");
      }
    }
    if (expectFallback && !captured.includes(FALLBACK_WARNING)) {
      throw new Error(
        `Linux smoke without a keyring did not log the safeStorage fallback.\n${captured.slice(-4000)}`,
      );
    }
    const keyFile = join(userData, "desktop-ui.key");
    if (
      expectFallback &&
      (await stat(keyFile).then(
        () => true,
        () => false,
      ))
    ) {
      throw new Error("desktop-ui.key was written without a keyring; the fallback did not run");
    }
    console.log(`${launch} desktop ${expectedVersion} answered /healthz on ${process.platform}`);
  } catch (error) {
    failure = error;
  } finally {
    if (child.exitCode === null && child.signalCode === null && !exitInfo) signal(child, "SIGTERM");
    if (child.exitCode === null && child.signalCode === null && !exitInfo) {
      const result = await Promise.race([exit, delay(10_000).then(() => "timeout")]);
      if (result === "timeout") signal(child, "SIGKILL");
      if (result === "timeout") {
        failure ??= new Error("desktop did not exit within 10 seconds after quit signal");
      }
    }
    const deadline = Date.now() + 10_000;
    let leftovers = [];
    do {
      leftovers = await listProcesses();
      if (leftovers.length === 0) break;
      await delay(500);
    } while (Date.now() < deadline);
    await logChain.catch(() => {});
    await writeDataRootListing().catch((error) => {
      failure ??= error;
    });
    if (leftovers.length > 0) {
      failure ??= new Error(
        `boof/Electron processes remain after 10 seconds:\n${leftovers.join("\n")}`,
      );
    }
  }
  if (failure) throw failure;
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
}
