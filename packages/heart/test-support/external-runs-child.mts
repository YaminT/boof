// Child process for the external-runs race test: one side of a race to complete a run.
// argv: <root> <runId> <startAtMs> <label>. Prints one JSON line: {"won": boolean}.
import { ExternalRunStore } from "../src/external-runs.ts";

const [root, runId, startAt, label] = process.argv.slice(2);
await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
const won = await new ExternalRunStore(root).complete(runId, { status: "ok", report: label });
console.log(JSON.stringify({ won }));
