import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultSettings,
  effectiveSettings,
  newTask,
  ProjectStore,
  SettingsStore,
  TaskStore,
} from "@boof/heart";
import { afterEach, describe, expect, it } from "vitest";
import { agentMarkerFor } from "./agent-marker.js";
import { Pipeline } from "./pipeline.js";
import { ToolRegistry } from "./tools/registry.js";
import type { RunOptions, Tool } from "./tools/types.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("pipeline agent marker", () => {
  it("passes agentMarkerFor(dataRoot) to the tool and claude-agent env", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "pipeline-marker-data-"));
    roots.push(dataRoot);
    const workDir = await mkdtemp(join(tmpdir(), "pipeline-marker-work-"));
    roots.push(workDir);
    await mkdir(workDir, { recursive: true });

    const settingsStore = new SettingsStore(dataRoot);
    await settingsStore.save({
      ...defaultSettings(),
      runner: { enabled: true, concurrency: 1 },
      defaultProject: "marker-test",
    });
    const project = await new ProjectStore(dataRoot).create({
      workingDirectory: workDir,
      id: "marker-test",
    });
    const projectDir = new ProjectStore(dataRoot).dir(project.id);
    const store = new TaskStore(projectDir);
    const tools = { planner: "claude-agent", developer: "claude-agent", reviewer: "claude-agent" };
    const task = newTask(
      {
        id: "marker-task",
        title: "Marker wiring",
        status: "pending",
        priority: 50,
        skip: false,
        labels: [],
        command: null,
        attachments: [],
        questions: "none",
        tools: {
          planner: { tool: tools.planner, model: "default" },
          developer: { tool: tools.developer, model: "default" },
          reviewer: { tool: tools.reviewer, model: "default" },
        },
        created: new Date(0).toISOString(),
        updated: new Date(0).toISOString(),
      },
      "Build the marker wiring test.",
    );
    await store.create(task);
    const running = await store.transition(task.frontmatter.id, "running");
    const received: RunOptions[] = [];
    const fakeTool: Tool = {
      id: "claude-agent",
      displayName: "Fake Claude Agent",
      defaultModels: ["default"],
      needsAgentAuth: true,
      async detect() {
        return { status: "available" };
      },
      async listModels() {
        return ["default"];
      },
      async run(opts) {
        received.push(opts);
        const report =
          opts.role === "planner"
            ? "# Plan\n\nBuild the wiring."
            : opts.role === "observer" || opts.role === "reviewer"
              ? "VERDICT: APPROVE"
              : "Implemented.";
        return { output: report, report };
      },
    };
    const outcome = await new Pipeline({
      root: projectDir,
      dataRoot,
      project,
      store,
      registry: new ToolRegistry([fakeTool]),
      settings: effectiveSettings(await settingsStore.load(), project),
      agentAuth: {
        decide: async () => ({ ok: true, via: "project-key" }),
        credentials: async () => ({ kind: "project-key", apiKey: "fake-test-key" }),
        configDir: async () => join(dataRoot, "claude-agent-config", project.id),
      } as never,
    }).run(running);

    expect(outcome.kind).toBe("done");
    expect(received.length).toBeGreaterThan(0);
    const expected = agentMarkerFor(dataRoot);
    expect(received.every((opts) => opts.agentMarker === expected)).toBe(true);
    expect(received.every((opts) => opts.env?.BOOF_RUNNER_AGENT_OF === expected)).toBe(true);
  });
});
