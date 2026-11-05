import type { AgentSdkEligibility } from "../api-types.js";
import {
  CLAUDE_AGENT_DEFAULT_TOOL_NOTE,
  CLAUDE_AGENT_DESKTOP_NOTE,
  agentSdkSummary,
  projectKeyLine,
} from "../lib/claude-agent.js";
import type { ClaudeAuth } from "../lib/settings-project.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { NativeSelect } from "../ui/native-select.js";

const label = "flex flex-col gap-1.5 text-[length:var(--text-body)] font-medium";
const help = "text-[length:var(--text-row)] font-normal text-ink-muted";

/**
 * Project settings › Claude Agent SDK: how claude-agent authenticates for this project.
 * The key is write-only: this component never receives it from the server, shows only whether one
 * is set, and holds nothing but what the user types now. On the desktop app it shows the note only.
 */
export function ClaudeAgentSection({
  desktop,
  auth,
  onAuth,
  keySet,
  typedKey,
  onTypedKey,
  replacing,
  onReplace,
  removing,
  onRemove,
  onKeep,
  problem,
  eligibility,
  eligibilityFailed,
}: {
  desktop: boolean;
  auth: ClaudeAuth;
  onAuth: (a: ClaudeAuth) => void;
  /** Whether the project has its own key (`anthropicApiKeySet`). The key itself is never available. */
  keySet: boolean;
  typedKey: string;
  onTypedKey: (v: string) => void;
  /** The user chose Replace: show the key field although a key is set. */
  replacing: boolean;
  onReplace: () => void;
  /** Remove is staged: the key goes when the page is saved. */
  removing: boolean;
  onRemove: () => void;
  /** Undo Replace or Remove. */
  onKeep: () => void;
  /** What is wrong with the typed value, if anything (never the value itself). */
  problem: string | null;
  eligibility: AgentSdkEligibility | null;
  eligibilityFailed: boolean;
}) {
  const summary = agentSdkSummary(eligibility);
  const keyLine = projectKeyLine(auth, keySet, eligibility);
  const showField = !keySet || replacing;
  return (
    <section aria-labelledby="claude-agent-heading" className="flex flex-col gap-4">
      <h2 id="claude-agent-heading" className="m-0 text-[length:var(--text-section)] font-semibold">
        Claude Agent SDK
      </h2>
      {desktop ? (
        <p data-testid="claude-agent-desktop-note" className="m-0 text-[length:var(--text-row)]">
          {CLAUDE_AGENT_DESKTOP_NOTE}
        </p>
      ) : (
        <>
          <p className={`m-0 ${help}`}>{CLAUDE_AGENT_DEFAULT_TOOL_NOTE}</p>
          <label className={label}>
            Authentication
            <NativeSelect
              className="w-full"
              value={auth}
              onChange={(e) => onAuth(e.target.value as ClaudeAuth)}
            >
              <option value="gateway">better-ccflare gateway (default)</option>
              <option value="project-key">This project&apos;s Anthropic API key</option>
            </NativeSelect>
          </label>

          <div className="flex flex-col gap-1.5" data-testid="claude-agent-key">
            <span className="text-[length:var(--text-body)] font-medium">Anthropic API key</span>
            {removing ? (
              <div className="flex flex-wrap items-center gap-2 text-[length:var(--text-row)]">
                <span>The key is removed when you save.</span>
                <Button type="button" variant="outline" size="sm" onClick={onKeep}>
                  Keep key
                </Button>
              </div>
            ) : showField ? (
              <div className="flex gap-2">
                <Input
                  type="password"
                  aria-label="Anthropic API key"
                  autoComplete="new-password"
                  spellCheck={false}
                  className="mt-0 font-mono font-normal"
                  placeholder="sk-ant-api…"
                  value={typedKey}
                  onChange={(e) => onTypedKey(e.target.value)}
                />
                {keySet && (
                  <Button type="button" variant="outline" onClick={onKeep}>
                    Cancel
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 text-[length:var(--text-row)]">
                <span className="font-medium text-done">A key is set</span>
                <Button type="button" variant="outline" size="sm" onClick={onReplace}>
                  Replace
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={onRemove}>
                  Remove
                </Button>
              </div>
            )}
            {problem && (
              <span className="text-[length:var(--text-row)] text-failed">{problem}</span>
            )}
            <span className={help}>
              Write-only: it is stored on the server and never shown again.{" "}
              {auth === "project-key"
                ? "Used for every claude-agent step of this project."
                : "Used when better-ccflare cannot be used for claude-agent."}
            </span>
          </div>

          <p data-testid="claude-agent-eligibility" className={`m-0 ${help}`}>
            {summary ??
              (eligibilityFailed
                ? "Could not check the better-ccflare accounts."
                : eligibility?.gateway === "absent"
                  ? "No better-ccflare gateway is configured."
                  : "Checking the better-ccflare accounts…")}
            {keyLine && (
              <>
                {" "}
                <strong data-testid="claude-agent-key-line" className="font-medium text-ink">
                  {keyLine}
                </strong>
              </>
            )}
          </p>
          <p className={`m-0 ${help}`}>
            Account pooling by{" "}
            <a href="https://github.com/tombii/better-ccflare" target="_blank" rel="noreferrer">
              better-ccflare
            </a>{" "}
            (MIT, © 2025 snipeship &amp; tombii), a fork of ccflare by snipeship.
          </p>
        </>
      )}
    </section>
  );
}
