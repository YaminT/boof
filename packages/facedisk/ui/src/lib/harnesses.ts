import type { HarnessInstall, HarnessStatus } from "../api-types.js";
import { CLAUDE_AGENT } from "./claude-agent.js";

/** What the UI environment says about tools that are never listed here. */
export interface HarnessEnv {
  isDesktop?: boolean;
}

/**
 * Whether a tool may be offered in a tool select. Before the install check has answered (`status`
 * is null: still loading, or it failed) every tool is offered, so the page stays usable. The
 * desktop app never lists claude-agent.
 */
export function toolIsOffered(
  tool: string,
  status: HarnessStatus | null,
  env: HarnessEnv = {},
): boolean {
  if (tool === CLAUDE_AGENT && env.isDesktop) return false;
  if (!status) return true;
  return status.tools[tool]?.installed === true;
}

/** True when the install check ran and a tool is not installed (a loading check says nothing). */
export function isNotInstalled(tool: string, status: HarnessStatus | null): boolean {
  return status !== null && status.tools[tool]?.installed !== true;
}

/**
 * The tools a select offers: the installed ones, plus `current` when it is saved but not
 * installed (kept, never silently changed).
 */
export function toolChoices(
  all: string[],
  status: HarnessStatus | null,
  env: HarnessEnv,
  current?: string,
): string[] {
  const offered = all.filter((t) => toolIsOffered(t, status, env));
  return current && !offered.includes(current) ? [...offered, current] : offered;
}

/** The text of a tool in a select: a kept tool that is not installed says so. */
export function harnessToolLabel(tool: string, status: HarnessStatus | null): string {
  return isNotInstalled(tool, status) ? `${tool} (not installed)` : tool;
}

type RoleChoices = Partial<Record<string, { tool: string } | undefined>>;

/** One warning per role whose saved tool is not installed; the project's own choice wins. */
export function notInstalledWarnings(
  globalRoles: RoleChoices,
  ownRoles: RoleChoices,
  status: HarnessStatus | null,
): string[] {
  if (!status) return [];
  const out: string[] = [];
  for (const role of ["planner", "developer", "observer", "reviewer"]) {
    const tool = (ownRoles[role] ?? globalRoles[role])?.tool;
    if (tool && isNotInstalled(tool, status))
      out.push(
        `${role[0].toUpperCase()}${role.slice(1)} uses ${tool}, which is not installed on this computer. Pick an installed tool, or install ${tool}; a task cannot start while it is missing.`,
      );
  }
  return out;
}

export type HarnessState = "installed" | "off-path" | "not-found";

export interface HarnessRow {
  id: string;
  info: HarnessInstall;
  state: HarnessState;
}

/** The doctor panel rows: installed first, then found off PATH, then not found; each by name. */
export function harnessRows(status: HarnessStatus, env: HarnessEnv = {}): HarnessRow[] {
  const rank = { installed: 0, "off-path": 1, "not-found": 2 } as const;
  return Object.entries(status.tools)
    .filter(([id]) => !(id === CLAUDE_AGENT && env.isDesktop))
    .map(([id, info]): HarnessRow => ({
      id,
      info,
      state: !info.installed ? "not-found" : info.foundOffPath ? "off-path" : "installed",
    }))
    .sort(
      (a, b) =>
        rank[a.state] - rank[b.state] || a.info.displayName.localeCompare(b.info.displayName),
    );
}

/** Where to get each coding agent. Static text; boof fetches nothing. */
export const INSTALL_HINTS: Record<string, { command?: string; url: string }> = {
  "claude-code": {
    command: "npm install -g @anthropic-ai/claude-code",
    url: "https://docs.claude.com/en/docs/claude-code/setup",
  },
  codex: { command: "npm install -g @openai/codex", url: "https://github.com/openai/codex" },
  opencode: { command: "npm install -g opencode-ai", url: "https://opencode.ai" },
};

/** True when the install check ran and found no coding agent at all. */
export const noAgentFound = (status: HarnessStatus | null): boolean =>
  status !== null && !status.anyInstalled;

/** The install help for the "No coding agent found" card: one entry per known harness. */
export function installHelp(): { id: string; command?: string; url: string }[] {
  return Object.entries(INSTALL_HINTS).map(([id, h]) => ({ id, ...h }));
}
