export * from "./agent-env.js";
export * from "./gateway-env.js";
export * from "./prompt-hierarchy.js";
export * from "./tools/types.js";
export * from "./tools/questions.js";
export * from "./tools/errors.js";
export * from "./tools/mock.js";
export * from "./tools/claude-code.js";
export const DESKTOP_CLAUDE_AGENT_REASON =
  "claude-agent is not available in the desktop app. It is available in the boof-runner CLI/server install (npm). The Claude Agent SDK is licensed under Anthropic's Commercial Terms (not open source) and its Claude Code binary is about 330 MB, so the desktop installers do not include it. Use claude-code here.";
export * from "./tools/codex.js";
export * from "./tools/opencode.js";
export * from "./tools/registry.js";
export * from "./worktree.js";
export * from "./pipeline.js";
export * from "./engine.js";
