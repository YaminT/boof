import { z } from "zod";
import { defineOp } from "../define-op.js";
import { HarnessStatusSchema } from "../schemas.js";

export const harnessesStatus = defineOp({
  name: "harnesses.status",
  title: "Installed coding agents",
  description:
    "Reports which coding-agent tools (harnesses) are installed on the computer that runs boof: for each tool whether it was found, its version and path, and whether it was found off PATH (foundOffPath). Also anyInstalled. Free: it looks for the program and asks it for `--version`; it never sends a prompt. The result is cached for five minutes; `refresh` re-checks (at most once every ten seconds). Needs settings:read.",
  scope: "settings:read",
  projectScoped: false,
  input: z.strictObject({ refresh: z.boolean().optional() }),
  output: HarnessStatusSchema,
  rest: { method: "GET", path: "/harnesses" },
  mcp: {
    expose: false,
    why: "A setup check for the web UI and the doctor command: it reveals local install paths, and the harness reference lists only what an agent should drive.",
  },
  summary: (r) =>
    Object.entries(r.tools)
      .map(([id, t]) => `${id}: ${t.installed ? "installed" : "not found"}`)
      .join(", "),
  handler: async (ctx, { refresh }) => ctx.services.harnesses(refresh === true),
});

export const harnessOps = [harnessesStatus] as const;
