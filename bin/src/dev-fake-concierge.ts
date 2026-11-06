import type { ConciergeAgent, ConciergeTurnInput } from "@boof/heart";
import { scriptedAgent, type ScriptStep } from "@boof/heart-server";

/**
 * Dev-only stand-in for the assistant, so the console can be tried and photographed without a
 * model. It is chosen only by `BOOF_DEV_FAKE_CONCIERGE` and never in production. It answers a few
 * fixed requests through the real MCP gate (so pending changes are real):
 *   "delete <taskId>", "queue <taskId>", "create <title>", anything else gets a canned answer.
 * `BOOF_DEV_FAKE_CONCIERGE=unavailable` makes it report that it cannot run.
 */
export function devFakeConcierge(
  env: Record<string, string | undefined> = process.env,
): ConciergeAgent | undefined {
  const flag = env.BOOF_DEV_FAKE_CONCIERGE;
  if (!flag || env.NODE_ENV === "production") return undefined;
  const unavailable = flag === "unavailable";
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
        say = `That would delete task ${arg}. Please review and confirm the change.`;
        calls.push({ call: "boof_delete_task", args: { projectId, taskId: arg } });
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
