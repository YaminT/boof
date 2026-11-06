// Child process for the runner guard test. argv: <dataRoot> <hold|crash> <startAtMs> <holdMs>.
// Tries to acquire the guard at the start time and prints one JSON line {acquired, at}; then
//   hold:  keeps it for holdMs and prints {releasing: <ms>} just before releasing it;
//   crash: dies at once with SIGKILL while holding it (no release).
// Times are Date.now() of this machine, so the parent can compare the holders' intervals.
import { RunnerGuard } from "../src/runner-guard.ts";

const [root, mode, startAt, holdMs] = process.argv.slice(2);
const guard = new RunnerGuard(root);
await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
const acquired = await guard.acquire();
const at = Date.now();
console.log(JSON.stringify({ acquired, at }));
if (acquired && mode === "crash") process.kill(process.pid, "SIGKILL");
if (acquired) {
  await new Promise((r) => setTimeout(r, Number(holdMs)));
  // Stamped just before release(): a true lower bound on when this child let go (a stamp taken
  // after it could be late if the child is descheduled, and let a correct lock fail the test).
  const releasing = Date.now();
  await guard.release();
  console.log(JSON.stringify({ releasing }));
}
