import { appendFile, chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { smokeCommand } from "./desktop-smoke-launch.mjs";

const FALLBACK_WARNING =
  "safeStorage unavailable: the desktop UI uses a browser session set by the app";

const repo = resolve(import.meta.dirname, "../../..");
const stagedApp = join(repo, "packages", "desktop", "build", "app");
const releaseDir = join(repo, "packages", "desktop", "build", "release");
const output = join(repo, ".desktop-smoke");
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

await mkdir(output, { recursive: true });
await mkdir(userData, { recursive: true });
await mkdir(process.env.HOME ?? userData, { recursive: true });
await mkdir(process.env.USERPROFILE ?? userData, { recursive: true });
const runtime = join(output, "runtime");
if (expectFallback) {
  await mkdir(runtime, { recursive: true });
  await chmod(runtime, 0o700);
}
const appImage = launch === "appimage" ? await findAppImage() : undefined;
if (appImage) await chmod(appImage, 0o755);
const electronBin = launch === "appimage" ? undefined : (await import("electron")).default;
const launched = smokeCommand({ launch, appImage, electronBin, stagedApp, userData });
const childEnv = {
  ...process.env,
  BOOF_RUNNER_PORT: String(port),
  HOME: process.env.HOME ?? userData,
  USERPROFILE: process.env.USERPROFILE ?? userData,
};
if (expectFallback) {
  childEnv.XDG_RUNTIME_DIR = runtime;
  delete childEnv.DBUS_SESSION_BUS_ADDRESS;
  delete childEnv.XDG_CURRENT_DESKTOP;
  delete childEnv.DESKTOP_SESSION;
  delete childEnv.GNOME_KEYRING_CONTROL;
}
// The AppImage runtime forks the app and does not forward signals: a SIGTERM to the runtime
// alone leaves the Electron processes running. Give it its own process group and signal that.
const ownGroup = launch === "appimage" && process.platform !== "win32";
const child = spawn(launched.command, launched.args, {
  cwd: repo,
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
  detached: ownGroup,
});

function signalChild(signal) {
  if (ownGroup && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is already gone; fall through to the single process.
    }
  }
  child.kill(signal);
}

let exitInfo;
let startupError;
let captured = "";
let logChain = Promise.resolve();
const exit = new Promise((done) => {
  child.once("error", (error) => {
    startupError = error;
    done({ error });
  });
  child.once("exit", (code, signal) => {
    exitInfo = { code, signal };
    done(exitInfo);
  });
});
child.stdout.on("data", (chunk) => {
  captured += chunk.toString();
  logChain = logChain.then(() => appendFile(stdoutPath, chunk));
});
child.stderr.on("data", (chunk) => {
  captured += chunk.toString();
  logChain = logChain.then(() => appendFile(stderrPath, chunk));
});

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
      } catch {}
    }
  }
  await walk(dataRoot);
  await writeFile(listingPath, `${lines.join("\n")}\n`);
}

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
        if (health.ok !== true)
          throw new Error(`health response was not ok: ${JSON.stringify(health)}`);
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
      )
        throw error;
      lastError = error.message;
    }
    await delay(500);
  }
  throw new Error(`health endpoint did not become ready within 60 seconds: ${lastError}`);
}

try {
  if (!expectedVersion) throw new Error("BOOF_SMOKE_EXPECTED_VERSION is required");
  if (Number.isNaN(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${port}`);
  await waitForHealth();
  const root = await stat(dataRoot);
  if (!root.isDirectory()) throw new Error(`data root is not a directory: ${dataRoot}`);
  const settings = await readFile(join(dataRoot, "settings.json"), "utf8");
  JSON.parse(settings);
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
  console.log(`${launch} desktop ${expectedVersion} started successfully on ${process.platform}`);
} catch (error) {
  startupError = error;
  throw error;
} finally {
  if (child.exitCode === null && child.signalCode === null) signalChild("SIGTERM");
  else if (ownGroup) signalChild("SIGTERM");
  if (child.exitCode === null && child.signalCode === null) {
    const result = await Promise.race([exit, delay(10_000).then(() => "timeout")]);
    if (result === "timeout") {
      for (const [name, path] of [
        ["stdout", stdoutPath],
        ["stderr", stderrPath],
      ]) {
        const text = await readFile(path, "utf8").catch(() => "");
        console.log(`--- desktop ${name} (last 4000 chars) ---\n${text.slice(-4000)}`);
      }
      console.log(`--- processes ---\n${(await listProcesses()).join("\n")}`);
      signalChild("SIGKILL");
      throw new Error("desktop did not exit within 10 seconds after quit signal");
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
  await writeDataRootListing();
  if (leftovers.length > 0)
    throw new Error(`boof/Electron processes remain after 10 seconds:\n${leftovers.join("\n")}`);
  if (startupError && !exitInfo) throw startupError;
}
