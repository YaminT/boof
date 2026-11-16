import { createContext, useContext } from "react";
import type { useRunnerOverview } from "./useRunnerOverview.js";

/** The one runner-overview poller (AppShell owns it); the topbar and Home read the same value. */
export type RunnerOverviewState = ReturnType<typeof useRunnerOverview>;

export const RunnerOverviewContext = createContext<RunnerOverviewState | null>(null);

export function useSharedRunnerOverview(): RunnerOverviewState | null {
  return useContext(RunnerOverviewContext);
}
