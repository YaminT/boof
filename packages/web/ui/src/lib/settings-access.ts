import type { SettingsPageId } from "./route.js";

/**
 * What a settings page needs. The key and automation pages load their own data, so a key without
 * `projects:read` or `settings:read` can still reach them. The forms need a project and the settings.
 */
export function settingsPageAccess(
  page: SettingsPageId,
  have: { settings: boolean; project: boolean },
): "forms" | "own" | "needs-projects-read" | "needs-settings-read" {
  if (page === "keys" || page === "automation" || page === "accounts") return "own";
  if (!have.project) return "needs-projects-read";
  return have.settings ? "forms" : "needs-settings-read";
}

export const NEEDS_SETTINGS_READ = "This browser's key cannot read settings (needs settings:read).";
export const NEEDS_PROJECTS_READ = "This browser's key cannot list projects (needs projects:read).";
