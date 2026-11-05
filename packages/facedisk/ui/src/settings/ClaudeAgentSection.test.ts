import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClaudeAgentNote } from "./ClaudeAgentNote.js";
import { ClaudeAgentSection } from "./ClaudeAgentSection.js";
import { AgentSdkBadge } from "./AgentSdkBadge.js";
import { CLAUDE_AGENT_DESKTOP_NOTE, CLAUDE_AGENT_NOTE } from "../lib/claude-agent.js";

const noop = () => {};
const SECRET = "sk-ant-api03-SECRETSECRETSECRETSECRET";
const section = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    h(ClaudeAgentSection, {
      desktop: false,
      auth: "gateway",
      onAuth: noop,
      keySet: false,
      typedKey: "",
      onTypedKey: noop,
      replacing: false,
      onReplace: noop,
      removing: false,
      onRemove: noop,
      onKeep: noop,
      problem: null,
      eligibility: null,
      eligibilityFailed: false,
      ...over,
    }),
  );

describe("ClaudeAgentSection (project page)", () => {
  it("offers both authentication choices and an empty write-only key field when no key is set", () => {
    const html = section();
    expect(html).toContain("Claude Agent SDK");
    expect(html).toContain("better-ccflare gateway (default)");
    expect(html).toContain("This project&#x27;s Anthropic API key");
    expect(html).toContain('placeholder="sk-ant-api…"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).not.toContain("A key is set");
    expect(html).toContain("Claude Code (claude-code) stays the default tool");
    expect(html).toContain("Account pooling by");
    expect(html).toContain("https://github.com/tombii/better-ccflare");
  });

  it("shows only that a key is set, with Replace and Remove, and never a value or a field", () => {
    const html = section({ keySet: true });
    expect(html).toContain("A key is set");
    expect(html).toContain("Replace");
    expect(html).toContain("Remove");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("sk-ant-api0");
    expect(html).not.toMatch(/<input[^>]*value=/);
  });

  it("shows the field again after Replace, without pre-filling it", () => {
    const html = section({ keySet: true, replacing: true });
    expect(html).toContain('type="password"');
    expect(html).toContain("Cancel");
    expect(html).not.toMatch(/<input[^>]*value="[^"]/);
  });

  it("says a staged removal happens on save and offers to keep the key", () => {
    const html = section({ keySet: true, removing: true });
    expect(html).toContain("The key is removed when you save.");
    expect(html).toContain("Keep key");
    expect(html).not.toContain("<input");
  });

  it("holds only what is typed now: a typed key sits in a password field, never as text", () => {
    const html = section({ typedKey: SECRET });
    expect(html).toContain('type="password"');
    // It is the field's own value; no text node, label or message repeats it.
    expect(html.split(SECRET).length - 1).toBe(1);
    expect(
      section({ typedKey: SECRET, problem: "That is not an Anthropic API key." }),
    ).not.toContain("<span>" + SECRET);
  });

  it("shows the eligibility line with the reason", () => {
    const html = section({
      eligibility: {
        gateway: "checked",
        allowed: false,
        reason: "the better-ccflare gateway would route to max (subscription)",
        blocking: [{ id: "b", name: "max", provider: "anthropic", why: "subscription" }],
      },
    });
    expect(html).toContain("not allowed. The better-ccflare gateway would route to max");
    expect(section({ eligibilityFailed: true })).toContain(
      "Could not check the better-ccflare accounts.",
    );
  });

  it("says which credential is used: the project key after a refused gateway, or always in project-key mode", () => {
    const refused = {
      gateway: "checked",
      allowed: false,
      reason: "the gateway would route to max (subscription)",
      blocking: [{ id: "b", name: "max", provider: "anthropic", why: "subscription" }],
    };
    const html = section({ keySet: true, eligibility: refused });
    expect(html).toContain("not allowed.");
    expect(html).toContain("claude-agent will use this project&#x27;s Anthropic API key.");
    expect(section({ keySet: false, eligibility: refused })).not.toContain("claude-agent-key-line");
    expect(section({ keySet: true, auth: "project-key", eligibility: refused })).toContain(
      "claude-agent always uses this project&#x27;s Anthropic API key.",
    );
  });

  it("on the desktop app shows only the explanation: no select, no key field", () => {
    const html = section({ desktop: true, keySet: true });
    expect(html).toContain(CLAUDE_AGENT_DESKTOP_NOTE.replace("'", "&#x27;"));
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("A key is set");
    expect(html).not.toContain("Authentication");
  });
});

describe("ClaudeAgentNote (role editor)", () => {
  it("shows the compliance note and the live line", () => {
    const base = { projectId: "a", roles: ["developer" as const], via: null, reason: null };
    const gateway = renderToStaticMarkup(
      h(ClaudeAgentNote, {
        kind: "auth",
        text: CLAUDE_AGENT_NOTE,
        auth: { ...base, allowed: true, via: "gateway" },
      }),
    );
    expect(gateway).toContain("Claude Agent SDK can steer a running step without restarting it.");
    expect(gateway).toContain("Ready: via better-ccflare");
    const key = renderToStaticMarkup(
      h(ClaudeAgentNote, {
        kind: "auth",
        text: CLAUDE_AGENT_NOTE,
        auth: { ...base, allowed: true, via: "project-key" },
      }),
    );
    expect(key).toContain("Ready: via the project&#x27;s API key");
    const refused = renderToStaticMarkup(
      h(ClaudeAgentNote, {
        kind: "auth",
        text: CLAUDE_AGENT_NOTE,
        auth: { ...base, allowed: false, reason: "claude-agent cannot start: no key" },
      }),
    );
    expect(refused).toContain("claude-agent cannot start: no key");
    expect(refused).not.toContain("Ready:");
  });

  it("shows the fixed desktop note instead, with no live line", () => {
    const html = renderToStaticMarkup(
      h(ClaudeAgentNote, { kind: "unavailable", text: CLAUDE_AGENT_DESKTOP_NOTE }),
    );
    expect(html).toContain("Not available in the desktop app.");
    expect(html).not.toContain("claude-agent-live");
    expect(html).not.toContain("Ready:");
  });
});

describe("AgentSdkBadge (accounts tab)", () => {
  it("renders the words allowed / not allowed, and nothing when unknown", () => {
    expect(renderToStaticMarkup(h(AgentSdkBadge, { badge: null }))).toBe("");
    expect(
      renderToStaticMarkup(
        h(AgentSdkBadge, { badge: { allowed: true, text: "Agent SDK: allowed" } }),
      ),
    ).toContain("Agent SDK: allowed");
    expect(
      renderToStaticMarkup(
        h(AgentSdkBadge, {
          badge: { allowed: false, text: "Agent SDK: not allowed (subscription)" },
        }),
      ),
    ).toContain("Agent SDK: not allowed (subscription)");
  });
});
