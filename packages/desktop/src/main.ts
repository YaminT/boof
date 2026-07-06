import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { RunnerEngine } from "@boof-runner/runner";
import { dataPaths, defaultSettings, SettingsStore, TaskStore } from "@boof-runner/shared";
import { startServer, type RunningServer } from "@boof-runner/web";

// Names the userData folder (~/Library/Application Support/Boof Runner, etc.) and the
// window/menu. Must run before any getPath("userData") call.
app.setName("Boof Runner");

const PORT = Number(process.env.BOOF_RUNNER_PORT ?? 4319);

let server: RunningServer | null = null;
let engine: RunnerEngine | null = null;
let win: BrowserWindow | null = null;

/**
 * Built React UI, served by the in-process server.
 * - Packaged (asar:false): main.js sits at <Resources>/app and the UI is staged
 *   beside it as ./ui, so serveStatic reads it as plain files on disk.
 * - Dev (`electron .`): dist/main.js resolves to the sibling @boof-runner/web package.
 */
function uiDir(): string {
  if (app.isPackaged) return join(__dirname, "ui");
  return resolve(__dirname, "..", "..", "web", "ui", "dist");
}

/**
 * Ensure the per-user data root exists. On a fresh install the working directory
 * is left blank so the UI's first-run gate prompts for it; thereafter it is
 * remembered in settings.json and never asked again.
 */
async function ensureDataRoot(): Promise<string> {
  const root = join(app.getPath("userData"), "data");
  await new TaskStore(root).ensureDirs();
  if (!existsSync(dataPaths(root).settings)) {
    await new SettingsStore(root).save(defaultSettings(""));
  }
  return root;
}

function createWindow(port: number): void {
  win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#e9edf2",
    title: "Boof Runner",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Open external links (e.g. docs) in the default browser, not a chrome-less
  // Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  void win.loadURL(`http://127.0.0.1:${port}`);
  win.on("closed", () => {
    win = null;
  });
}

ipcMain.handle("boof-runner:pick-directory", async (_event, current?: string) => {
  const result = await dialog.showOpenDialog({
    title: "Choose working directory",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: current && existsSync(current) ? current : undefined,
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

async function boot(): Promise<void> {
  const root = await ensureDataRoot();
  server = await startServer({ root, port: PORT, uiDir: uiDir() });
  engine = new RunnerEngine({ root });
  void engine.loop();
  createWindow(server.port);
}

// Single-instance: a second launch focuses the existing window instead of
// fighting over the server port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app
    .whenReady()
    .then(boot)
    .catch((err) => {
      console.error("Boof Runner failed to start:", err);
      dialog.showErrorBox("Boof Runner failed to start", String(err?.stack ?? err));
      app.quit();
    });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && server) createWindow(server.port);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  let shuttingDown = false;
  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    shuttingDown = true;
    event.preventDefault();
    void (async () => {
      try {
        engine?.stop();
        await server?.stop();
      } finally {
        app.exit(0);
      }
    })();
  });
}
