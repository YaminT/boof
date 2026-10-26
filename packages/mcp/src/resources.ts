import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError, type ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { toOpError } from "@boof-runner/api";
import { goalFilePath, PLAN_FILE } from "@boof-runner/shared";
import type { McpRuntime } from "./server.js";

const JSON_MIME = "application/json";
const TEXT_MIME = "text/plain";

/** Variables of a matched URI template are strings or lists; ours are single ids. */
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : (v ?? ""));

const asJson = (uri: URL, value: unknown): ReadResourceResult => ({
  contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(value, null, 2) }],
});
const asText = (uri: URL, text: string): ReadResourceResult => ({
  contents: [{ uri: uri.href, mimeType: TEXT_MIME, text }],
});

/** Operation failures become protocol errors for resource reads (they have no isError result). */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof McpError) throw err;
    const e = toOpError(err);
    throw new McpError(ErrorCode.InvalidParams, `${e.code}: ${e.message}`);
  }
}

/**
 * Read-only views of projects, plans and tasks for clients that prefer resources. Each read
 * runs the same operation (and so the same scope and project checks) as the matching tool.
 */
export function registerResources(server: McpServer, rt: McpRuntime): void {
  const call = (name: string, input: Record<string, unknown>) => rt.run(rt.op(name), input);

  /** With a fixed project the other projects do not exist for this server. */
  const visibleProjects = async (): Promise<{ id: string; name: string }[]> => {
    const { projects } = (await call("projects.list", {})) as {
      projects: { id: string; name: string }[];
    };
    const only = rt.options.project;
    return only ? projects.filter((p) => p.id === only) : projects;
  };
  const checkProject = (pid: string): void => {
    const only = rt.options.project;
    if (only !== undefined && pid !== only) {
      throw new McpError(ErrorCode.InvalidParams, `forbidden_project: only ${only} is served`);
    }
  };

  server.registerResource(
    "projects",
    "boof://projects",
    { title: "Projects", description: "All projects.", mimeType: JSON_MIME },
    (uri) => guard(async () => asJson(uri, { projects: await visibleProjects() })),
  );

  server.registerResource(
    "project",
    new ResourceTemplate("boof://projects/{pid}", {
      list: () =>
        guard(async () => ({
          resources: (await visibleProjects()).map((p) => ({
            uri: `boof://projects/${p.id}`,
            name: `project-${p.id}`,
            title: p.name,
            mimeType: JSON_MIME,
          })),
        })),
    }),
    { title: "Project", description: "One project.", mimeType: JSON_MIME },
    (uri, vars) =>
      guard(async () => {
        const pid = one(vars.pid);
        checkProject(pid);
        return asJson(uri, await call("projects.get", { projectId: pid }));
      }),
  );

  server.registerResource(
    "plan",
    new ResourceTemplate("boof://projects/{pid}/plans/{planId}", {
      list: () =>
        guard(async () => {
          const resources = [];
          for (const p of await visibleProjects()) {
            const { plans } = (await call("plans.list", { projectId: p.id })) as {
              plans: { id: string; title: string }[];
            };
            for (const plan of plans) {
              resources.push({
                uri: `boof://projects/${p.id}/plans/${plan.id}`,
                name: `plan-${p.id}-${plan.id}`,
                title: plan.title,
                mimeType: JSON_MIME,
              });
            }
          }
          return { resources };
        }),
    }),
    { title: "Plan", description: "A plan with its goals.", mimeType: JSON_MIME },
    (uri, vars) =>
      guard(async () => {
        const pid = one(vars.pid);
        checkProject(pid);
        return asJson(uri, await call("plans.get", { projectId: pid, planId: one(vars.planId) }));
      }),
  );

  server.registerResource(
    "plan-xml",
    new ResourceTemplate("boof://projects/{pid}/plans/{planId}/xml", { list: undefined }),
    {
      title: "Plan as plan.boof.xml",
      description: "The exported plan.boof.xml; goal files are at .../xml/{goalId}.",
      mimeType: TEXT_MIME,
    },
    (uri, vars) =>
      guard(async () => {
        const pid = one(vars.pid);
        checkProject(pid);
        const files = (await call("plans.export", {
          projectId: pid,
          planId: one(vars.planId),
        })) as Record<string, string>;
        return asText(uri, files[PLAN_FILE] ?? "");
      }),
  );

  server.registerResource(
    "plan-goal-xml",
    new ResourceTemplate("boof://projects/{pid}/plans/{planId}/xml/{goalId}", { list: undefined }),
    {
      title: "Goal as goal.boof.xml",
      description: "The exported goal.boof.xml of one goal.",
      mimeType: TEXT_MIME,
    },
    (uri, vars) =>
      guard(async () => {
        const pid = one(vars.pid);
        checkProject(pid);
        const planId = one(vars.planId);
        const plan = (await call("plans.get", { projectId: pid, planId })) as {
          goals: { id: string; path?: string }[];
        };
        const goal = plan.goals.find((g) => g.id === one(vars.goalId));
        if (!goal) throw new McpError(ErrorCode.InvalidParams, "not_found: No such goal");
        const files = (await call("plans.export", { projectId: pid, planId })) as Record<
          string,
          string
        >;
        return asText(uri, files[goalFilePath(goal)] ?? "");
      }),
  );

  server.registerResource(
    "task",
    new ResourceTemplate("boof://projects/{pid}/tasks/{taskId}", {
      list: () =>
        guard(async () => {
          const resources = [];
          for (const p of await visibleProjects()) {
            const { items } = (await call("tasks.list", { projectId: p.id, limit: 50 })) as {
              items: { frontmatter: { id: string; title: string } }[];
            };
            for (const t of items) {
              resources.push({
                uri: `boof://projects/${p.id}/tasks/${t.frontmatter.id}`,
                name: `task-${p.id}-${t.frontmatter.id}`,
                title: t.frontmatter.title,
                mimeType: JSON_MIME,
              });
            }
          }
          return { resources };
        }),
    }),
    { title: "Task", description: "A task without its log.", mimeType: JSON_MIME },
    (uri, vars) =>
      guard(async () => {
        const pid = one(vars.pid);
        checkProject(pid);
        return asJson(uri, await call("tasks.get", { projectId: pid, taskId: one(vars.taskId) }));
      }),
  );

  server.registerResource(
    "task-log",
    new ResourceTemplate("boof://projects/{pid}/tasks/{taskId}/log", { list: undefined }),
    {
      title: "Task log",
      description: "The live or stored agent log of a task.",
      mimeType: TEXT_MIME,
    },
    (uri, vars) =>
      guard(async () => {
        const pid = one(vars.pid);
        checkProject(pid);
        const { log } = (await call("tasks.liveLog", {
          projectId: pid,
          taskId: one(vars.taskId),
        })) as { log: string };
        return asText(uri, log);
      }),
  );
}
