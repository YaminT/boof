export type FocusMode = "simple" | "expanded";

const key = (screen: string) => `boof:focus-mode:v1:${screen}`;

/** The screen's remembered mode; simple when nothing valid is stored or storage is unavailable. */
export function readFocusMode(screen: string, storage?: Pick<Storage, "getItem">): FocusMode {
  try {
    return storage?.getItem(key(screen)) === "expanded" ? "expanded" : "simple";
  } catch {
    return "simple";
  }
}

/** Remember the mode; a failing store is ignored (the choice then lasts until the page closes). */
export function writeFocusMode(
  screen: string,
  mode: FocusMode,
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    storage?.setItem(key(screen), mode);
  } catch {
    // Storage may be blocked.
  }
}
