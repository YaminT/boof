import { contextBridge, ipcRenderer } from "electron";

// Minimal, audited surface exposed to the web UI. contextIsolation is on, so the
// renderer only ever sees this object — never Node or Electron internals.
// API key for the in-process server, created and kept encrypted by the main
// process; null when safeStorage is unavailable (the UI then relies on local trust).
const token: string | null = ipcRenderer.sendSync("boof-runner:get-token");

contextBridge.exposeInMainWorld("boofRunnerDesktop", {
  isDesktop: true,
  ...(token ? { token } : {}),
  platform: process.platform,
  /** Open the native folder picker; resolves to the chosen path or null. */
  pickDirectory: (current?: string): Promise<string | null> =>
    ipcRenderer.invoke("boof-runner:pick-directory", current),
});
