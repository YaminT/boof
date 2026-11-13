import { api, ApiError } from "../api.js";

/** Pause and Start: the global switch, or the selected project for a project-restricted key. */
export async function setRunner(enable: boolean, pid: string | null): Promise<void> {
  try {
    await api.setRunnerEnabled(enable);
  } catch (err) {
    if (err instanceof ApiError && err.code === "forbidden_project" && pid) {
      await (enable ? api.resumeProject(pid) : api.pauseProject(pid));
      return;
    }
    throw err;
  }
}
