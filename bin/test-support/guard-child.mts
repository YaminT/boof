// Child process for the runner guard test. argv: <dataRoot> <hold|crash> <startAtMs> <holdMs>.
// Tries to acquire the guard at the start time, prints one JSON line {acquired}, then
//   hold:  keeps it for holdMs and releases it;
//   crash: dies at once with SIGKILL while holding it (no release).
import { RunnerGuard } from "../src/runner-guard.ts";

const [root, mode, startAt, holdMs] = process.argv.slice(2);
const guard = new RunnerGuard(root);
await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
const acquired = await guard.acquire();
console.log(JSON.stringify({ acquired }));
if (acquired && mode === "crash") process.kill(process.pid, "SIGKILL");
if (acquired) {
  await new Promise((r) => setTimeout(r, Number(holdMs)));
  await guard.release();
}
