import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  safeStorage,
  session,
  shell,
} from "electron";
import { RunnerEngine } from "@boof/runner";
import { boot } from "@boof/boof/boot";
import {
  AuthStore,
  BrowserSessionStore,
  dataRootPaths,
  migrateDataRoot,
  dataRootAccessNotice,
  securitySettings,
  SettingsStore,
  tightenDataRoot,
} from "@boof/heart";
import type { RunningServer } from "@boof/heart-server";
import {
  SAFE_STORAGE_FALLBACK_WARNING,
  createQuitHandler,
  createWindowAuth,
  desktopKeyringAvailable,
  isAppUrl,
  isExternalUrl,
  operatorClientId,
  shutdownGraceMs,
} from "./lifecycle.js";

// Names the userData folder (~/Library/Application Support/Boof Runner, etc.) and the
// window/menu. Must run before any getPath("userData") call.
app.setName("Boof Runner");

const PORT = Number(process.env.BOOF_RUNNER_PORT ?? 4319);
const SHUTDOWN_GRACE_MS = shutdownGraceMs();

let server: RunningServer | null = null;
let engine: RunnerEngine | null = null;
let win: BrowserWindow | null = null;
/** Signs the window in (browser-session cookie) before each load when there is no desktop key. */
let windowAuth: ReturnType<typeof createWindowAuth> | null = null;
let windowPending = false;
/** API key for the bundled UI; undefined when safeStorage is unavailable (browser-session fallback). */
let desktopToken: string | undefined;

const DESKTOP_CLIENT_NAME = "desktop-ui";

/**
 * Encryption availability and, on Linux, the secret-store backend. A probe that throws
 * (no D-Bus, no keyring daemon) is treated as "no keyring" so startup continues.
 */
function readSafeStorage(): { encryptionAvailable: boolean; backend: string | null } {
  try {
    const encryptionAvailable = safeStorage.isEncryptionAvailable();
    if (process.platform !== "linux") return { encryptionAvailable, backend: null };
    return { encryptionAvailable, backend: safeStorage.getSelectedStorageBackend() };
  } catch (err) {
    console.warn("safeStorage probe failed:", err);
    return { encryptionAvailable: false, backend: null };
  }
}

/**
 * Make sure a `desktop-ui` admin client exists and return its key. The secret is
 * kept encrypted with Electron safeStorage (OS keychain) in a file under
 * userData. Without a keyring there is nowhere safe to keep it. On Linux that
 * includes Chromium's `basic_text` backend, so the app signs its own window in
 * with a browser session instead (see startComposition).
 */
async function ensureDesktopToken(root: string): Promise<string | undefined> {
  const probe = readSafeStorage();
  if (
    !desktopKeyringAvailable({
      platform: process.platform,
      encryptionAvailable: probe.encryptionAvailable,
      backend: probe.backend,
    })
  ) {
    console.warn(SAFE_STORAGE_FALLBACK_WARNING);
    return undefined;
  }
  const store = new AuthStore(root);
  const keyFile = join(app.getPath("userData"), "desktop-ui.key");
  try {
    if (existsSync(keyFile)) {
      const key = safeStorage.decryptString(await readFile(keyFile));
      if ((await store.verify(key)).ok) return key;
    }
  } catch (err) {
    console.warn("could not read stored desktop key; issuing a new one:", err);
  }
  const existing = await store.get(DESKTOP_CLIENT_NAME);
  const issued =
    existing && !existing.revokedAt
      ? await store.rotate(DESKTOP_CLIENT_NAME)
      : await store.create({
          name: DESKTOP_CLIENT_NAME,
          kind: "ui",
          scopes: ["admin"],
          trust: "trusted",
        });
  if (!issued) return undefined;
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(keyFile, safeStorage.encryptString(issued.key), { mode: 0o600 });
  await chmod(keyFile, 0o600).catch(() => {});
  return issued.key;
}

// The preload script reads the key synchronously before the page's scripts run.
// Only the app's own pages get the key; a foreign page that got into the window sees null.
let appOrigin = "";
const fromApp = (event: { senderFrame?: { url: string } | null }): boolean =>
  !!event.senderFrame && isAppUrl(event.senderFrame.url, appOrigin);

ipcMain.on("boof-runner:get-token", (event) => {
  event.returnValue = fromApp(event) ? (desktopToken ?? null) : null;
});

/**
 * Built React UI, served by the in-process server.
 * - Packaged (asar:false): main.js sits at <Resources>/app and the UI is staged
 *   beside it as ./ui, so serveStatic reads it as plain files on disk.
 * - Dev (`electron .`): dist/main.js resolves the UI from packages/facedisk/ui/dist.
 */
function uiDir(): string {
  if (app.isPackaged) return join(__dirname, "ui");
  return resolve(__dirname, "..", "..", "facedisk", "ui", "dist");
}

/**
 * Ensure the per-user data root exists in layout v2: a v1 root is migrated, a fresh one gets
 * default settings with no projects (the UI's first-run gate asks for the first repository).
 */
async function ensureDataRoot(): Promise<string> {
  const root = join(app.getPath("userData"), "data");
  await mkdir(root, { recursive: true });
  const tightened = await tightenDataRoot(root);
  if (tightened.unsafeParent) console.warn(`warning: ${tightened.unsafeParent.message}`);
  if (!tightened.changed || ("via" in tightened && tightened.via === "acl")) {
    const notice = dataRootAccessNotice(root, tightened);
    if (notice) console.warn(notice);
  }
  await migrateDataRoot(root);
  await mkdir(dataRootPaths(root).projects, { recursive: true });
  return root;
}

async function createWindow(): Promise<void> {
  if (!server || !windowAuth || win || windowPending) return;
  windowPending = true;
  try {
    await windowAuth?.prepare();
  } finally {
    windowPending = false;
  }
  if (win) return;
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
  const openExternal = (url: string) => {
    if (isExternalUrl(url)) void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  // The window never leaves the app origin: other URLs go to the system browser instead.
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (isAppUrl(url, appOrigin)) return;
    event.preventDefault();
    openExternal(url);
  };
  win.webContents.on("will-navigate", (event, url) => guard(event, url));
  win.webContents.on("will-redirect", (event, url) => guard(event, url));
  void win.loadURL(appOrigin);
  win.on("closed", () => {
    win = null;
  });
}

ipcMain.handle(
  "boof-runner:pick-directory",
  async (event, current?: string, opts?: { title?: string }) => {
    if (!fromApp(event)) return null;
    const result = await dialog.showOpenDialog({
      title: opts?.title ?? "Choose working directory",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: current && existsSync(current) ? current : undefined,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  },
);

async function startComposition(): Promise<void> {
  const root = await ensureDataRoot();
  desktopToken = await ensureDesktopToken(root).catch((err) => {
    console.error("desktop auth setup failed; using a browser session:", err);
    return undefined;
  });
  const composition = await boot({
    root,
    claudeAgent: "unavailable",
    port: PORT,
    uiDir: uiDir(),
    version: app.getVersion(),
    serverOptions: operatorClientId(desktopToken)
      ? { operatorClients: new Set([operatorClientId(desktopToken)!]) }
      : {},
    onServer: (activeServer) => {
      server = activeServer;
    },
    onRunner: (activeEngine) => {
      engine = activeEngine;
    },
  });
  appOrigin = `http://127.0.0.1:${composition.server.port}`;
  const sessions = new BrowserSessionStore(root);
  windowAuth = createWindowAuth({
    desktopToken: () => desktopToken,
    loadAuthMode: async () => securitySettings(await new SettingsStore(root).load()).auth.mode,
    createSession: () => sessions.createSession(),
    revokeSession: (id) => sessions.revokeSession(id),
    setCookie: (cookie) => session.defaultSession.cookies.set(cookie),
    warn: console.warn,
    error: console.error,
    showFailure: async (message) => {
      await dialog.showMessageBox({
        type: "warning",
        title: "Boof Runner",
        message: "Boof Runner could not sign in",
        detail: message,
      });
    },
    origin: appOrigin,
    port: composition.server.port,
  });
  await createWindow();
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
    .then(startComposition)
    .catch((err) => {
      console.error("Boof Runner failed to start:", err);
      dialog.showErrorBox("Boof Runner failed to start", String(err?.stack ?? err));
      app.quit();
    });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  const quit = createQuitHandler({
    engine: () => engine,
    server: () => server,
    exit: (code) => app.exit(code),
    graceMs: SHUTDOWN_GRACE_MS,
    cleanup: () => windowAuth?.release(),
    log: console.log,
    notify: (message) => {
      win?.setTitle(`Boof Runner — ${message}`);
      if (Notification.isSupported())
        new Notification({ title: "Boof Runner", body: message }).show();
    },
  });
  app.on("before-quit", (event) => void quit(event));
}
