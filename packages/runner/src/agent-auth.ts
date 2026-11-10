import type { Project, Settings } from "@boof/heart";
import { claudeAgentConfigDir, isAnthropicApiKey } from "@boof/heart";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  agentAuthRefusalMessage,
  agentKeyIsSeparate,
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
  /** boof's admin better-ccflare key: used only for the eligibility check, never given to a child. */
  readGatewayKey: () => Promise<string | null>;
  /** The api-only agent key: the only gateway credential a claude-agent child receives. */
  readAgentKey: () => Promise<string | null>;
  projectKeys?: ProjectKeyStore;
  fetch?: typeof fetch;
  now?: () => number;
}

export type AgentAuthResolution =
  AgentAuthDecision | { ok: false; unreachable: true; reason: string };

const CACHE_MS = 30_000;

export class AgentAuthResolver {
  private readonly projectKeys: ProjectKeyStore;
  private readonly fetcher?: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; eligibility: AgentSdkEligibility }>();
  private readonly inFlight = new Map<string, Promise<AgentSdkEligibility>>();
  /** Rejected admin-route probes, keyed by gateway URL and the agent key. Accepted and unknown are not cached. */
  private readonly probeCache = new Map<string, { at: number }>();
  private readonly probeInFlight = new Map<string, Promise<"rejected" | "accepted" | "unknown">>();
  private readonly checked = new WeakMap<object, { url: string; key: string; agentKey: string }>();

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
  ): Promise<AgentAuthResolution> {
    const fresh = typeof options === "boolean" ? options : options.fresh === true;
    try {
      const settings = await this.options.loadSettings();
      const gateway = settings.owlish;
      const choice = project.claudeAgent?.auth ?? "gateway";
      const hasProjectKey = await this.projectKeys.has(project.id);
      let agentKey: string | null = null;
      if (choice === "gateway" && gateway) {
        try {
          agentKey = await this.options.readAgentKey();
        } catch {
          // An unreadable agent key closes the gateway route like a missing one.
        }
      }
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

      // A gateway cannot serve the Agent SDK without a distinct child credential.
      // Decide locally so outages never turn this definite refusal/fallback into a wait.
      let gatewayKey: string | null = null;
      if (choice === "gateway" && gateway) {
        try {
          gatewayKey = await this.options.readGatewayKey();
        } catch {
          // Handled below as unavailable.
        }
      }
      const keysAreSeparate = agentKeyIsSeparate(gatewayKey, agentKey);
      if (choice === "gateway" && gateway && (!agentKey || !keysAreSeparate)) {
        return decideAgentAuth({
          projectName: project.name,
          choice,
          gatewayConfigured: true,
          eligibility: {
            gateway: "checked",
            allowed: true,
            reason: "",
            blocking: [],
            checkedAt: new Date(this.now()).toISOString(),
          },
          hasProjectKey,
          hasAgentKey: false,
          keysAreSeparate,
        });
      }

      // A different string is not enough: the agent key must be refused by the admin-only
      // account list. Equal strings already returned above and never touch the network.
      // No admin key means the gateway route stays closed without a probe.
      if (choice === "gateway" && gateway && agentKey && gatewayKey) {
        const probe = await this.probeAgentKey(gateway.url, agentKey, fresh);
        if (probe === "accepted") {
          return decideAgentAuth({
            projectName: project.name,
            choice,
            gatewayConfigured: true,
            eligibility: {
              gateway: "checked",
              allowed: true,
              reason: "",
              blocking: [],
              checkedAt: new Date(this.now()).toISOString(),
            },
            hasProjectKey,
            hasAgentKey: false,
            keysAreSeparate: false,
          });
        }
        if (probe !== "rejected") {
          return {
            ok: false,
            unreachable: true,
            reason: refusal(project, "the better-ccflare gateway is unreachable"),
          };
        }
      }

      let eligibility: AgentSdkEligibility | null = null;
      let checkedKey = "";
      if (gateway) {
        // A missing/unreadable gateway key closes the gateway route, but a project's
        // explicitly stored key remains an independent compliant credential.
        const key = gatewayKey;
        if (!key) {
          eligibility = {
            gateway: "checked",
            allowed: false,
            reason: "no better-ccflare client key is configured",
            blocking: [],
            checkedAt: new Date(this.now()).toISOString(),
          };
        } else {
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
      }
      if (eligibility?.failure) {
        return {
          ok: false,
          unreachable: true,
          reason: refusal(project, "the better-ccflare gateway is unreachable"),
        };
      }
      const decision = decideAgentAuth({
        projectName: project.name,
        choice,
        gatewayConfigured: Boolean(gateway),
        eligibility,
        hasProjectKey,
        hasAgentKey: Boolean(agentKey),
        keysAreSeparate,
      });
      if (decision.ok && decision.via === "gateway")
        this.checked.set(decision, {
          url: gateway!.url,
          key: checkedKey,
          agentKey: agentKey ?? "",
        });
      return decision;
    } catch {
      return {
        ok: false,
        reason: refusal(project, "authentication settings or credentials could not be read"),
      };
    }
  }

  /**
   * GET /api/accounts with the agent key. A rejection is cached for 30 s and simultaneous
   * checks share one request. `fresh` always asks again and is what `credentials` uses.
   */
  private async probeAgentKey(
    url: string,
    agentKey: string,
    fresh: boolean,
  ): Promise<"rejected" | "accepted" | "unknown"> {
    const cacheKey = `${url}:${createHash("sha256").update(agentKey).digest("hex")}`;
    const cached = this.probeCache.get(cacheKey);
    if (!fresh && cached && this.now() - cached.at < CACHE_MS) return "rejected";
    let request = !fresh ? this.probeInFlight.get(cacheKey) : undefined;
    if (!request) {
      const client = new OwlishClient({
        url,
        apiKey: agentKey,
        fetch: this.fetcher,
        now: this.now,
      });
      request = client.probeAdminRoute();
      if (!fresh) this.probeInFlight.set(cacheKey, request);
    }
    try {
      const result = await request;
      if (result === "rejected") this.probeCache.set(cacheKey, { at: this.now() });
      else this.probeCache.delete(cacheKey);
      return result;
    } finally {
      if (this.probeInFlight.get(cacheKey) === request) this.probeInFlight.delete(cacheKey);
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
      const agentKey = await this.options.readAgentKey();
      if (
        !checked ||
        !settings.owlish ||
        settings.owlish.url !== checked.url ||
        key !== checked.key ||
        !key ||
        agentKey !== checked.agentKey ||
        !agentKey
      )
        throw new AgentAuthRefusedError(
          refusal(project, "gateway settings changed after eligibility was checked"),
        );
      // Ask again. A key that was api-only at decide time may have been replaced by an admin key.
      const probe = await this.probeAgentKey(checked.url, agentKey, true);
      if (probe !== "rejected")
        throw new AgentAuthRefusedError(
          refusal(
            project,
            probe === "accepted"
              ? "the agent key must be a separate api-only better-ccflare key, not the admin client key"
              : "the better-ccflare gateway is unreachable",
          ),
        );
      // The admin key stays here; the child gets only the api-only agent key.
      return { kind: "gateway", url: checked.url, apiKey: checked.agentKey };
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
  marker?: string,
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
  if (marker !== undefined) env.BOOF_RUNNER_AGENT_OF = marker;
  return env;
}
