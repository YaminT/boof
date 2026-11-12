import { api } from "../api.js";
import { act } from "../lib/act.js";

/** Flips the runner on or off, reporting a failure as a toast. */
export function toggleRunner(enabled: boolean): Promise<unknown> {
  return act(() => api.updateSettings({ runner: { enabled: !enabled } }), {
    failure: enabled ? "Could not pause the runner" : "Could not start the runner",
  });
}
