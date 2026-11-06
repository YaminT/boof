import type { ConciergeAgent, ConciergeTurnInput } from "@boof/heart";
import {
  scriptedAgent,
  type ScriptStep,
} from "../../packages/heart-server/src/concierge/fake-agent.js";

/**
 * Dev-only stand-in for the assistant, so the console can be tried and photographed without a
 * model. It lives outside every build: only `dev-serve.mts` (run with tsx) loads it. It answers a few
 * fixed requests through the real MCP gate (so pending changes are real):
 *   "delete <taskId> [detach]", "queue <taskId>", "create <title>", anything else gets a canned answer.
 * With `unavailable` it reports that it cannot run.
 */
export function devFakeConcierge(mode: "available" | "unavailable"): ConciergeAgent {
  const unavailable = mode === "unavailable";
  return {
    async availability() {
      return unavailable
        ? {
            available: false,
            reason: "No compliant API key is set for this project.",
            via: null,
          }
        : { available: true, reason: null, via: "project-key" };
    },
    async turn(input: ConciergeTurnInput) {
      const request = userRequest(input.prompt);
      const [verb, ...rest] = request.split(/\s+/);
      const arg = rest.join(" ");
      const projectId = input.project.id;
      let say: string;
      const calls: ScriptStep[] = [];
      if (verb === "delete" && arg) {
        const detach = arg.endsWith(" detach");
        const taskId = detach ? arg.slice(0, -" detach".length) : arg;
        say = `That would delete task ${taskId}. Please review and confirm the change.`;
        calls.push({
          call: "boof_delete_task",
          args: { projectId, taskId, ...(detach ? { detach: true } : {}) },
        });
      } else if (verb === "queue" && arg) {
        say = `I can queue task ${arg} once you apply the change.`;
        calls.push({ call: "boof_queue_task", args: { projectId, taskId: arg } });
      } else if (verb === "create" && arg) {
        say = `I drafted a task: ${arg}.`;
        calls.push({
          call: "boof_create_task",
          args: { projectId, title: arg, prompt: arg },
        });
      } else {
        say =
          "Here is what I see.\n- Two tasks are waiting for you.\n- Nothing is running.\nLiteral markup stays literal: <script>alert(1)</script> and [a link](https://example.com) and **not bold**.";
      }
      let text = "";
      for (const word of say.split(/(?<=\s)/)) {
        if (input.signal?.aborted) break;
        text += word;
        input.onEvent?.({ type: "text", text: word });
        await new Promise((r) => setTimeout(r, 25));
      }
      const agent = scriptedAgent(calls);
      const result = await agent.turn({ ...input, onEvent: undefined });
      return { ...result, text };
    },
  };
}

function userRequest(prompt: string): string {
  const m = /<user_request>\n([\s\S]*?)\n<\/user_request>/.exec(prompt);
  return (m?.[1] ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim()
    .toLowerCase();
}
