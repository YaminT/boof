import type { Role, RoleAssignment, TaskTools } from "@boof/heart/schema";
import type { AgentAuthEntry, AgentSdkEligibility } from "../api-types.js";

/** The tool id of the opt-in Claude Agent SDK adapter. */
export const CLAUDE_AGENT = "claude-agent";

/** Shown under the role editor when a role uses claude-agent. */
export const CLAUDE_AGENT_NOTE =
  "Claude Agent SDK can steer a running step without restarting it. Anthropic allows it only with API-key authentication, so subscription (OAuth) accounts stay on Claude Code (claude-code). It runs through better-ccflare only when every account there is an API-key, console, Bedrock or Vertex account; otherwise it needs this project's own Anthropic API key.";

/** Shown instead of the note wherever the desktop app cannot offer claude-agent. */
export const CLAUDE_AGENT_DESKTOP_NOTE =
  "Not available in the desktop app. claude-agent runs in the boof-runner CLI/server install (npm). The Claude Agent SDK is under Anthropic's Commercial Terms (not open source) and its binary is about 330 MB, so the desktop app does not include it. Use Claude Code (claude-code) here.";

export const CLAUDE_AGENT_DESKTOP_PROBLEM = "claude-agent is not available in the desktop app.";

export const CLAUDE_AGENT_DEFAULT_TOOL_NOTE =
  "Claude Code (claude-code) stays the default tool; choose claude-agent per role in Settings › Agents.";

/** Where a Claude Agent SDK key may be typed: only a valid Anthropic API key (no OAuth or admin key). */
const API_KEY_SHAPE = /^sk-ant-api\d{2}-[\x21-\x7e]{16,500}$/;
export const isApiKeyShape = (v: string): boolean => API_KEY_SHAPE.test(v);

/** What the UI environment says about tools that cannot run here. */
export interface ToolAvailability {
  isDesktop?: boolean;
  /** `unavailableReason` per tool, as the tool listings of the API report it. */
  unavailable?: Record<string, string | undefined>;
}

/** Why a tool cannot be chosen here, or null. The desktop app never offers claude-agent. */
export function toolUnavailableReason(tool: string, env: ToolAvailability): string | null {
  if (tool === CLAUDE_AGENT && env.isDesktop) return CLAUDE_AGENT_DESKTOP_NOTE;
  return env.unavailable?.[tool] ?? null;
}

/** The problem that blocks Save while a role uses a tool that is unavailable here, or null. */
export function toolUnavailableProblem(tool: string, env: ToolAvailability): string | null {
  if (tool === CLAUDE_AGENT && env.isDesktop) return CLAUDE_AGENT_DESKTOP_PROBLEM;
  const reason = env.unavailable?.[tool];
  return reason ? `${tool} is not available: ${reason}` : null;
}

const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The live line under the role note: ready via which route, or why not. */
export function agentAuthLine(entry: AgentAuthEntry | undefined): string | null {
  if (!entry) return null;
  if (entry.allowed)
    return entry.via === "project-key"
      ? "Ready: via the project's API key"
      : "Ready: via better-ccflare";
  return entry.reason ?? "Not ready: claude-agent cannot start here.";
}

/** The badge of one gateway account: allowed or not, and why. Null when it cannot be told. */
export function agentSdkBadge(
  accountId: string,
  eligibility: AgentSdkEligibility | null,
): { allowed: boolean; text: string } | null {
  if (!eligibility || eligibility.gateway !== "checked") return null;
  const blocked = eligibility.blocking.find((b) => b.id === accountId);
  if (blocked) {
    const why =
      blocked.why === "subscription"
        ? "subscription"
        : blocked.why === "oauth-token"
          ? "OAuth token"
          : "unknown type";
    return { allowed: false, text: `Agent SDK: not allowed (${why})` };
  }
  // A closed gate with nothing to blame (unreadable list, no accounts) says nothing about this one.
  if (!eligibility.allowed && eligibility.blocking.length === 0) return null;
  return { allowed: true, text: "Agent SDK: allowed" };
}

/** The summary line above the account list. */
export function agentSdkSummary(eligibility: AgentSdkEligibility | null): string | null {
  if (!eligibility || eligibility.gateway !== "checked") return null;
  return `Claude Agent SDK through this gateway: ${eligibility.allowed ? "allowed" : "not allowed"}. ${sentence(eligibility.reason)}${/[.!?]$/.test(eligibility.reason) ? "" : "."}`;
}

/** The roles a draft assigns to claude-agent, own project overrides first. */
export function claudeAgentRoles(
  globalRoles: Partial<Record<Role, RoleAssignment | undefined>>,
  ownRoles: Partial<Record<Role, RoleAssignment | undefined>>,
): Role[] {
  return (["planner", "developer", "observer", "reviewer"] as const).filter(
    (r) => (ownRoles[r] ?? globalRoles[r])?.tool === CLAUDE_AGENT,
  );
}

const ROLE_BY_STEP: [RegExp, Role][] = [
  [/^planner/i, "planner"],
  [/^developer/i, "developer"],
  [/^observer/i, "observer"],
  [/^reviewer/i, "reviewer"],
];

/** The role of a step label ("Developer", "Reviewer (round 2)"), or null. */
export function stepRole(label: string | undefined): Role | null {
  if (!label) return null;
  return ROLE_BY_STEP.find(([re]) => re.test(label.trim()))?.[1] ?? null;
}

type RoleChoices = Partial<Record<Role, RoleAssignment | undefined>>;

/** The tool a role runs for a task: the task's own choice, the project's, then all projects'. */
export function effectiveTool(
  role: Role,
  taskTools: TaskTools | undefined,
  project: { roles?: RoleChoices } | null | undefined,
  settings: { roles?: RoleChoices } | null | undefined,
): string | null {
  return (
    taskTools?.[role]?.tool ?? project?.roles?.[role]?.tool ?? settings?.roles?.[role]?.tool ?? null
  );
}

/** Tools whose running step can switch model through an inject with mode "now". */
const MODEL_SWITCH_TOOLS = new Set(["claude-agent", "claude-code"]);

/** The models offered by "Switch model" for the tool of the running step; empty when it has none. */
export function switchModelChoices(
  tool: string | null,
  models: Record<string, string[]> | undefined,
): string[] {
  if (!tool || !MODEL_SWITCH_TOOLS.has(tool)) return [];
  return [...new Set(models?.[tool] ?? [])];
}

/** True when a queued task would run claude-agent in a role the project's entry names. */
function taskUsesClaudeAgent(
  tools: TaskTools | undefined,
  entry: Pick<AgentAuthEntry, "roles">,
): boolean {
  if (tools && Object.values(tools).some((a) => a?.tool === CLAUDE_AGENT)) return true;
  return entry.roles.some((r) => !tools?.[r] || tools[r]?.tool === CLAUDE_AGENT);
}

/** The refusal to show in the Now lane: the project is refused and a queued task would use claude-agent. */
export function claudeAgentRefusal(
  entry: AgentAuthEntry | undefined,
  queued: { frontmatter: { tools?: TaskTools } }[],
): string | null {
  if (!entry || entry.allowed) return null;
  if (!queued.some((t) => taskUsesClaudeAgent(t.frontmatter.tools, entry))) return null;
  return entry.reason ?? "claude-agent cannot start for this project.";
}

/**
 * Which credential claude-agent ends up using for a project, from the project's auth choice,
 * whether it has a key (`anthropicApiKeySet`) and the gateway eligibility. Null when the gateway
 * is simply used or nothing is known yet.
 */
export function projectKeyLine(
  auth: "gateway" | "project-key",
  keySet: boolean,
  eligibility: AgentSdkEligibility | null,
): string | null {
  if (auth === "project-key")
    return keySet
      ? "claude-agent always uses this project's Anthropic API key."
      : "claude-agent needs this project's Anthropic API key: enter one above.";
  if (keySet && eligibility && !eligibility.allowed)
    return "claude-agent will use this project's Anthropic API key.";
  return null;
}
