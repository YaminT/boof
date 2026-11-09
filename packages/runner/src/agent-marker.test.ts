import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_MARKER_ENV, agentMarkerFor, isAgentOf } from "./agent-marker.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const value = await mkdtemp(join(tmpdir(), "boof-agent-marker-"));
  roots.push(value);
  return value;
}

describe("agent marker", () => {
  it("same root via a symlink gives the same marker; another root differs", async () => {
    const actual = await root();
    const alias = join(tmpdir(), `boof-agent-marker-link-${process.pid}-${Date.now()}`);
    roots.push(alias);
    await symlink(actual, alias);
    const other = await root();

    expect(agentMarkerFor(alias)).toBe(agentMarkerFor(actual));
    expect(agentMarkerFor(actual)).not.toBe(agentMarkerFor(other));
    expect(agentMarkerFor(actual)).toMatch(/^[0-9a-f]{32}$/);
    expect(await realpath(alias)).toBe(await realpath(actual));
  });

  it("isAgentOf is false without the variable and for another root", async () => {
    const dataRoot = await root();
    const otherRoot = await root();

    expect(isAgentOf({}, dataRoot)).toBe(false);
    expect(isAgentOf({ [AGENT_MARKER_ENV]: agentMarkerFor(otherRoot) }, dataRoot)).toBe(false);
    expect(isAgentOf({ [AGENT_MARKER_ENV]: agentMarkerFor(dataRoot) }, dataRoot)).toBe(true);
  });
});
