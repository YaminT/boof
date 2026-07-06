import { useState } from "react";
import { api } from "./api.js";
import { desktop } from "./desktop.js";

/**
 * Shared logic for choosing/changing the working directory. In the desktop app
 * it opens a native folder dialog; in a plain browser it surfaces a text modal
 * (the page has no access to real filesystem paths). The chosen path persists
 * to settings.json, so the user is only ever asked once.
 */
export function useWorkingDir(current: string, onChange: () => void) {
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await api.updateSettings({ workingDirectory: trimmed });
      onChange();
      setModalOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const change = async () => {
    if (desktop) {
      const picked = await desktop.pickDirectory(current);
      if (picked) await save(picked);
    } else {
      setModalOpen(true);
    }
  };

  return { change, save, modalOpen, setModalOpen, busy, isDesktop: Boolean(desktop) };
}
