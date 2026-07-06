import { contextBridge, ipcRenderer } from "electron";

// Minimal, audited surface exposed to the web UI. contextIsolation is on, so the
// renderer only ever sees this object — never Node or Electron internals.
contextBridge.exposeInMainWorld("boofClawDesktop", {
  isDesktop: true,
  platform: process.platform,
  /** Open the native folder picker; resolves to the chosen path or null. */
  pickDirectory: (current?: string): Promise<string | null> =>
    ipcRenderer.invoke("boof-claw:pick-directory", current),
});
