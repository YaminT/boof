import type { Project, Settings } from "@boof/heart";
import {
  AGENT_AUTH_POLICY,
  decideAgentAuth,
  OwlishClient,
  ProjectKeyStore,
  type AgentAuth,
  type AgentAuthDecision,
  type AgentSdkEligibility,
} from "@boof/owlish";
import { gatewayEnv } from "./gateway-env.js";

export class AgentAuthRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentAuthRefusedError";
  }
}

export interface AgentAuthResolverOptions {
  root: string;
  loadSettings: () => Promise<Settings>;
  readGatewayKey: () => Promise<string | null>;
  projectKeys?: ProjectKeyStore;
  fetch?: typeof fetch;
  now?: () => number;
}

const CACHE_MS = 30_000;

export class AgentAuthResolver {
  private readonly projectKeys: ProjectKeyStore;
  private readonly fetcher?: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; eligibility: AgentSdkEligibility }>();

  constructor(private readonly options: AgentAuthResolverOptions) {
    this.projectKeys = options.projectKeys ?? new ProjectKeyStore(options.root);
    this.fetcher = options.fetch;
    this.now = options.now ?? Date.now;
  }

  async decide(project: Project, fresh = false): Promise<AgentAuthDecision> {
    const settings = await this.options.loadSettings();
    const gateway = settings.owlish;
    const choice = project.claudeAgent?.auth ?? "gateway";
    const hasProjectKey = await this.projectKeys.has(project.id);
    if (choice === "project-key")
      return decideAgentAuth({
        projectName: project.name,
        choice,
        gatewayConfigured: Boolean(gateway),
        eligibility: null,
        hasProjectKey,
      });

    let eligibility: AgentSdkEligibility | null = null;
    if (gateway) {
      const cached = this.cache.get(gateway.url);
      if (!fresh && cached && this.now() - cached.at < CACHE_MS) eligibility = cached.eligibility;
      else {
        const client = new OwlishClient({
          url: gateway.url,
          apiKey: (await this.options.readGatewayKey()) ?? undefined,
          fetch: this.fetcher,
          now: this.now,
        });
        eligibility = await client.agentSdkEligibility();
        this.cache.set(gateway.url, { at: this.now(), eligibility });
      }
    }
    return decideAgentAuth({
      projectName: project.name,
      choice,
      gatewayConfigured: Boolean(gateway),
      eligibility,
      hasProjectKey,
    });
  }

  async credentials(
    project: Project,
    decision: AgentAuthDecision & { ok: true },
  ): Promise<AgentAuth> {
    if (decision.via === "project-key") {
      const apiKey = await this.projectKeys.get(project.id);
      if (!apiKey)
        throw new AgentAuthRefusedError(
          `claude-agent cannot start: the project API key is no longer set. ${AGENT_AUTH_POLICY} Set an Anthropic API key for project "${project.name}" (Settings › Project), or use claude-code for this role.`,
        );
      return { kind: "project-key", apiKey };
    }
    const settings = await this.options.loadSettings();
    if (!settings.owlish)
      throw new AgentAuthRefusedError(
        `claude-agent cannot start: no better-ccflare gateway is configured. ${AGENT_AUTH_POLICY} Set an Anthropic API key for project "${project.name}" (Settings › Project), or use claude-code for this role.`,
      );
    const apiKey = await this.options.readGatewayKey();
    return { kind: "gateway", url: settings.owlish.url, ...(apiKey ? { apiKey } : {}) };
  }
}

const AUTH_ENV_NAMES = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

export function claudeAgentEnv(
  base: NodeJS.ProcessEnv,
  auth: AgentAuth,
  clientApp: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (
      value === undefined ||
      name.startsWith("BOOF_") ||
      AUTH_ENV_NAMES.has(name) ||
      name.startsWith("CLAUDE_CODE_USE_") ||
      name.startsWith("ANTHROPIC_FOUNDRY_")
    )
      continue;
    env[name] = value;
  }
  if (auth.kind === "gateway") Object.assign(env, gatewayEnv("anthropic", auth));
  else env.ANTHROPIC_API_KEY = auth.apiKey;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = clientApp;
  return env;
}
