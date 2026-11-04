import type { Project, Settings, SettingsPatch } from "@boof-runner/shared/schema";
import { changedKeys, type PageModel, type PageValues } from "./settings-draft.js";

export interface AccountsGlobal {
  enabled: boolean;
  url: string;
  healthGate: "pause" | "warn" | "off";
}
export type AccountsValues = PageValues<AccountsGlobal, Record<string, never>>;

export const accountsPage: PageModel<AccountsValues> = {
  values: (s: Settings, _p: Project) => ({
    global: {
      enabled: !!s.owlish,
      url: s.owlish?.url ?? "http://127.0.0.1:8080",
      healthGate: s.owlish?.healthGate ?? "pause",
    },
    project: {},
  }),
  problems: (v) => {
    if (!v.global.enabled) return [];
    try {
      const u = new URL(v.global.url);
      return ["http:", "https:"].includes(u.protocol) ? [] : ["Use an http or https gateway URL."];
    } catch {
      return ["Enter a valid gateway URL."];
    }
  },
  patches: (form, base, latest) => {
    const changed = new Set(changedKeys(form.global, base.global));
    if (!changed.size) return {};
    const settings: SettingsPatch = {};
    if (!form.global.enabled) settings.owlish = null;
    else if (changed.has("enabled") || changed.has("url") || changed.has("healthGate")) {
      settings.owlish = {
        url: changed.has("url")
          ? form.global.url.trim()
          : (latest.settings.owlish?.url ?? form.global.url.trim()),
        healthGate: changed.has("healthGate")
          ? form.global.healthGate
          : (latest.settings.owlish?.healthGate ?? form.global.healthGate),
      };
    }
    return { settings };
  },
};
