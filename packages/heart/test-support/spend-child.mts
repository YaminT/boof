// Child process for the budget test: records spend into a shared data root from its own pid.
// argv: <root> <startAtMs> <count> <costUsd>. Prints one JSON line.
import { recordSpend } from "../src/budget.ts";

const [root, startAt, count, cost] = process.argv.slice(2);
await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
try {
  for (let i = 0; i < Number(count); i++) {
    await recordSpend({
      dataRoot: root,
      projectId: "p",
      tool: "concierge",
      usage: { costUsd: Number(cost), known: true },
      timezone: "UTC",
      now: new Date("2026-10-26T12:00:00Z"),
    });
  }
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, message: (err as Error).message }));
}
