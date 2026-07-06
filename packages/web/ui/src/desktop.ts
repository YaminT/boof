// Bridge to the Electron main process, injected by the preload script when Boof Claw
// runs as a desktop app. Undefined in a plain browser, where the UI falls back
// to a text input for the working directory.

export interface DesktopBridge {
  isDesktop: true;
  platform: string;
  /** Open a native folder picker; resolves to the chosen path or null. */
  pickDirectory(current?: string): Promise<string | null>;
}

declare global {
  interface Window {
    boofClawDesktop?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | undefined =
  typeof window !== "undefined" ? window.boofClawDesktop : undefined;

export const isDesktop = Boolean(desktop);
