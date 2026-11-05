import type { Project, Settings } from "@boof/heart";
import { claudeAgentConfigDir, isAnthropicApiKey } from "@boof/heart";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  agentAuthRefusalMessage,
  decideAgentAuth,
  OwlishClient,
  ProjectKeyStore,
  type AgentAuth,
  type AgentAuthDecision,
  type AgentSdkEligibility,
} from "@boof/owlish";
import { gatewayEnv } from "./gateway-env.js";
import { createHash } from "node:crypto";

const refusal = (project: Project, why: string) => agentAuthRefusalMessage(project.name, why);

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
  private readonly inFlight = new Map<string, Promise<AgentSdkEligibility>>();
  private readonly checked = new WeakMap<object, { url: string; key: string }>();

  constructor(private readonly options: AgentAuthResolverOptions) {
    this.projectKeys = options.projectKeys ?? new ProjectKeyStore(options.root);
    this.fetcher = options.fetch;
    this.now = options.now ?? Date.now;
  }

  async configDir(project: Project): Promise<string> {
    const path = claudeAgentConfigDir(this.options.root, project.id);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700).catch(() => {});
    await chmod(path, 0o700).catch(() => {});
    return path;
  }

  /** `fresh` skips the 30-second eligibility cache; the engine must use it before each step. */
  async decide(
    project: Project,
    options: { fresh?: boolean } | boolean = {},
  ): Promise<AgentAuthDecision> {
    const fresh = typeof options === "boolean" ? options : options.fresh === true;
    try {
      const settings = await this.options.loadSettings();
      const gateway = settings.owlish;
      const choice = project.claudeAgent?.auth ?? "gateway";
      const hasProjectKey = await this.projectKeys.has(project.id);
      if (choice === "project-key") {
        const decision = decideAgentAuth({
          projectName: project.name,
          choice,
          gatewayConfigured: Boolean(gateway),
          eligibility: null,
          hasProjectKey,
        });
        return decision;
      }

      let eligibility: AgentSdkEligibility | null = null;
      let checkedKey = "";
      if (gateway) {
        const key = await this.options.readGatewayKey();
        if (!key)
          return {
            ok: false,
            reason: refusal(project, "no better-ccflare client key is configured"),
          };
        checkedKey = key;
        const cacheKey = `${gateway.url}:${createHash("sha256").update(key).digest("hex")}`;
        const cached = this.cache.get(cacheKey);
        if (!fresh && cached && this.now() - cached.at < CACHE_MS && cached.eligibility.allowed)
          eligibility = cached.eligibility;
        else {
          let request = this.inFlight.get(cacheKey);
          if (!request || fresh) {
            const client = new OwlishClient({
              url: gateway.url,
              apiKey: key,
              fetch: this.fetcher,
              now: this.now,
            });
            request = client.agentSdkEligibility();
            if (!fresh) this.inFlight.set(cacheKey, request);
          }
          try {
            eligibility = await request;
          } finally {
            if (this.inFlight.get(cacheKey) === request) this.inFlight.delete(cacheKey);
          }
          if (eligibility.allowed) this.cache.set(cacheKey, { at: this.now(), eligibility });
        }
      }
      const decision = decideAgentAuth({
        projectName: project.name,
        choice,
        gatewayConfigured: Boolean(gateway),
        eligibility,
        hasProjectKey,
      });
      if (decision.ok && decision.via === "gateway")
        this.checked.set(decision, { url: gateway!.url, key: checkedKey });
      return decision;
    } catch {
      return {
        ok: false,
        reason: refusal(project, "authentication settings or credentials could not be read"),
      };
    }
  }

  async credentials(
    project: Project,
    decision: AgentAuthDecision & { ok: true },
  ): Promise<AgentAuth> {
    if (decision.via === "project-key") {
      try {
        const apiKey = await this.projectKeys.get(project.id);
        if (!apiKey || !isAnthropicApiKey(apiKey))
          throw new AgentAuthRefusedError(
            refusal(project, "the project's API key is missing or invalid"),
          );
        return { kind: "project-key", apiKey };
      } catch (error) {
        if (error instanceof AgentAuthRefusedError) throw error;
        throw new AgentAuthRefusedError(refusal(project, "the project key store cannot be read"));
      }
    }
    try {
      const checked = this.checked.get(decision);
      const settings = await this.options.loadSettings();
      const key = await this.options.readGatewayKey();
      if (
        !checked ||
        !settings.owlish ||
        settings.owlish.url !== checked.url ||
        key !== checked.key ||
        !key
      )
        throw new AgentAuthRefusedError(
          refusal(project, "gateway settings changed after eligibility was checked"),
        );
      return { kind: "gateway", url: checked.url, apiKey: checked.key };
    } catch (error) {
      if (error instanceof AgentAuthRefusedError) throw error;
      throw new AgentAuthRefusedError(
        refusal(project, "authentication settings or credentials could not be read"),
      );
    }
  }
}

const SAFE_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "LANG",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "SHELL",
  "TZ",
  "SYSTEMROOT",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "USERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMDATA",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

export function claudeAgentEnv(
  base: NodeJS.ProcessEnv,
  auth: AgentAuth,
  clientApp: string,
  configDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (
      value === undefined ||
      (!SAFE_ENV_NAMES.has(name) && !name.startsWith("LC_") && !name.startsWith("XDG_"))
    )
      continue;
    env[name] = value;
  }
  if (auth.kind === "gateway") {
    if (!auth.apiKey) throw new Error("claude-agent gateway credentials are required");
    const gateway = gatewayEnv("anthropic", auth);
    env.ANTHROPIC_BASE_URL = gateway.ANTHROPIC_BASE_URL!;
    env.ANTHROPIC_API_KEY = auth.apiKey;
    const host = new URL(auth.url).hostname;
    for (const name of ["NO_PROXY", "no_proxy"]) {
      const entries = (env[name] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (!entries.includes(host)) entries.push(host);
      env[name] = entries.join(",");
    }
  } else env.ANTHROPIC_API_KEY = auth.apiKey;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = clientApp;
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}
