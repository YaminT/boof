import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpRuntime } from "./server.js";

const user = (text: string) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
});

/** Two small prompt templates that make a plain agent session a usable planning harness. */
export function registerPrompts(server: McpServer, rt: McpRuntime): void {
  const fixed = rt.options.project;

  server.registerPrompt(
    "boof_plan_project",
    {
      title: "Plan a project",
      description:
        "Turns a goal statement and a repository summary into a boof plan, ready for boof_create_plan.",
      argsSchema: {
        goal: z.string().describe("What the project or change must achieve."),
        repoSummary: z.string().optional().describe("Short summary of the repository."),
        ...(fixed ? {} : { projectId: z.string().optional().describe("Target boof project id.") }),
      },
    },
    (args) => {
      const projectId = fixed ?? (args as { projectId?: string }).projectId;
      return user(
        [
          "Write a boof plan for the goal below. Split the work into goals of one reviewable unit each.",
          "",
          `Goal: ${args.goal}`,
          args.repoSummary ? `Repository: ${args.repoSummary}` : "",
          "",
          "Each goal has these fields:",
          "- id: kebab-case, unique in the plan.",
          "- title: one line.",
          "- order: integer from 1, the intended sequence.",
          "- dependsOn: ids of goals that must be done first (no cycles).",
          "- spec.goal: what the unit delivers.",
          "- spec.stack: language and frameworks.",
          "- spec.rules.do and spec.rules.dont: concrete rules for the developer agent.",
          "- spec.tests: strategy, technology, run (the command) and optional coverage.",
          "",
          "Give every goal a test strategy that a reviewer can run. Keep the dependency graph shallow.",
          projectId
            ? `Then call boof_create_plan with projectId "${projectId}" and the goals, and boof_sync_plan to queue the tasks.`
            : "Then call boof_list_projects to choose the project, boof_create_plan with the goals, and boof_sync_plan to queue the tasks.",
        ]
          .filter((l) => l !== "")
          .join("\n"),
      );
    },
  );

  server.registerPrompt(
    "boof_review_plan",
    {
      title: "Review a plan",
      description: "Asks the model to critique the dependency graph and test strategy of a plan.",
      argsSchema: {
        planId: z.string().describe("Plan id."),
        ...(fixed ? {} : { projectId: z.string().describe("Project id.") }),
      },
    },
    (args) => {
      const projectId = fixed ?? (args as { projectId?: string }).projectId ?? "";
      return user(
        [
          `Review plan "${args.planId}" in project "${projectId}". Call boof_get_plan first.`,
          "",
          "Check and report:",
          "1. Dependencies: cycles, missing links, goals that could run in parallel, goals ordered against their dependencies.",
          "2. Size: goals that are too large to review in one pass, or too small to matter.",
          "3. Tests: every goal has a runnable test command, a strategy and a technology that fit its stack.",
          "4. Gaps: work the goal statement needs that no goal covers.",
          "",
          "List concrete fixes. Apply them with boof_upsert_goal or boof_replace_goals, passing the plan's expectedVersion.",
        ].join("\n"),
      );
    },
  );
}
