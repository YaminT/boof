/**
 * The environment a task agent runs in. The server's own environment is not passed on: it may
 * hold the keys and addresses of boof itself (`BOOF_KEY`, `BOOF_URL`), cloud credentials and
 * tokens the agent has no business with. Only what a command-line agent needs is kept.
 *
 * This limits what an agent *inherits*. It is not a sandbox: the agent runs as your OS user and
 * can read your files and unset the CLI refusal marker (see docs/boof-runner.md, "Agents are not sandboxed").
 */

/** Names kept as they are: the shell basics, the temp and cache locations, TLS and proxy settings. */
const KEEP_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
  // Proxies and certificates: the agent's network access, as the user configured it.
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
  // Windows (the desktop app ships there): without these no program starts.
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
]);

/**
 * Prefixes kept: locale, XDG directories, and each tool's own settings. Gateway addresses are
 * removed afterwards; see `STRIP_GATEWAY`. Provider API keys stay unless a pool credential is
 * injected for this task.
 */
const KEEP_PREFIXES = ["LC_", "XDG_", "ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_", "OPENCODE_"];

/**
 * Gateway addresses and admin tokens. Never inherited from the server process, and never restored
 * by `runner.agentEnv`. A shell that starts boof often exports the better-ccflare admin token
 * (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and the same for the other tools). The pool path
 * adds the address one task needs afterwards, through `gatewayEnv`.
 */
const STRIP_GATEWAY = new Set([
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENCODE_CONFIG_CONTENT",
]);

/**
 * Provider API keys. A task that uses the user's own key keeps them, and `runner.agentEnv` may
 * name them. When this task injects a pool credential, they are dropped: the pool path sets the
 * key the task should use and must not sit beside the user's key.
 */
const POOL_OVERRIDES_API_KEYS = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);

/** Never passed, whatever `extra` says: boof's own variables, which name its data root and port. */
const NEVER_PREFIX = "BOOF_";

export interface AgentEnvOptions {
  /** True when this task's environment will receive a pool or gateway credential. */
  injectPoolCredential?: boolean;
}

/**
 * `env` reduced to the allowlist, plus the variables named in `extra` (`settings.runner.agentEnv`)
 * that are set. `BOOF_*` and gateway addresses are always dropped. Provider API keys are dropped
 * only while `injectPoolCredential` is set; otherwise `extra` can pass them through.
 */
export function agentEnv(
  env: NodeJS.ProcessEnv = process.env,
  extra: readonly string[] = [],
  marker?: string,
  opts?: AgentEnvOptions,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const wanted = new Set(extra);
  const stripApiKeys = opts?.injectPoolCredential === true;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || name.startsWith(NEVER_PREFIX) || STRIP_GATEWAY.has(name)) continue;
    if (stripApiKeys && POOL_OVERRIDES_API_KEYS.has(name)) continue;
    if (KEEP_NAMES.has(name) || KEEP_PREFIXES.some((p) => name.startsWith(p)) || wanted.has(name)) {
      out[name] = value;
    }
  }
  if (marker !== undefined) out.BOOF_RUNNER_AGENT_OF = marker;
  return out;
}
