import { describe, expect, it } from "vitest";
import { agentsReadyText, countReadyAgents } from "./agent-count.js";

describe("countReadyAgents", () => {
  const tools = {
    "claude-code": { ready: true },
    codex: { ready: true },
    "claude-agent": { ready: false },
  };
  it("counts every ready tool, whatever its kind", () => {
    expect(countReadyAgents(tools)).toBe(2);
    expect(agentsReadyText(tools)).toBe("2 agents ready");
  });
  it("uses the singular for one", () => {
    expect(agentsReadyText({ codex: { ready: true } })).toBe("1 agent ready");
    expect(agentsReadyText({})).toBe("0 agents ready");
  });
});
