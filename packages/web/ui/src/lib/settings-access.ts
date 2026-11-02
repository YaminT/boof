import type { SettingsPageId } from "./route.js";

/**
 * What a settings page needs. The forms (Project, Agents, Budgets) read the settings; the key and
 * automation lists load their own data, so a key without `settings:read` can still reach them.
 */
export function settingsPageAccess(
  page: SettingsPageId,
  settingsLoaded: boolean,
): "forms" | "own" | "needs-settings-read" {
  if (page === "keys" || page === "automation") return "own";
  return settingsLoaded ? "forms" : "needs-settings-read";
}

export const NEEDS_SETTINGS_READ = "This browser's key cannot read settings (needs settings:read).";
