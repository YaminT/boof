import { stat } from "node:fs/promises";
import {
  dataRootPaths,
  SecuritySettingsSchema,
  securitySettings,
  type SecuritySettings,
} from "@boof-runner/shared";
import type { TaskService } from "./service.js";

/**
 * Security settings read through the settings file, reloaded when its mtime or
 * size changes (one stat per call). Keeps the last good value if unreadable.
 */
export function securityConfigReader(service: TaskService): () => Promise<SecuritySettings> {
  const path = dataRootPaths(service.root).settings;
  let sig = "";
  let cached: SecuritySettings = SecuritySettingsSchema.parse({});
  return async () => {
    try {
      const st = await stat(path);
      const next = `${st.mtimeMs}:${st.size}`;
      if (next !== sig) {
        cached = securitySettings(await service.loadSettings());
        sig = next;
      }
    } catch {
      /* keep the last known good value */
    }
    return cached;
  };
}
