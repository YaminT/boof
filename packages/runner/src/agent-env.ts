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

/** Prefixes kept: locale, XDG directories, and each tool's own variables (keys, gateway URLs). */
const KEEP_PREFIXES = ["LC_", "XDG_", "ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_", "OPENCODE_"];

/** Never passed, whatever `extra` says: boof's own variables, which name its data root and port. */
const NEVER_PREFIX = "BOOF_";

/**
 * `env` reduced to the allowlist, plus the variables named in `extra` (`settings.runner.agentEnv`)
 * that are set. `BOOF_*` is always dropped.
 */
export function agentEnv(
  env: NodeJS.ProcessEnv = process.env,
  extra: readonly string[] = [],
  marker?: string,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const wanted = new Set(extra);
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || name.startsWith(NEVER_PREFIX)) continue;
    if (KEEP_NAMES.has(name) || KEEP_PREFIXES.some((p) => name.startsWith(p)) || wanted.has(name)) {
      out[name] = value;
    }
  }
  if (marker !== undefined) out.BOOF_RUNNER_AGENT_OF = marker;
  return out;
}
