// Dev-only server with a scripted assistant, for trying and photographing the console without a
// model. Run with tsx, never built or shipped:
//   BOOF_DEV_FAKE=available|unavailable npx tsx bin/test-support/dev-serve.mts serve -d <data> -p <port> --no-runner
// It injects the fake in-process (a global that only this file sets), then starts the normal CLI.
import { fileURLToPath } from "node:url";
import { devFakeConcierge } from "./dev-fake-concierge.ts";

const mode = process.env.BOOF_DEV_FAKE === "unavailable" ? "unavailable" : "available";
(globalThis as { __boofDevConcierge?: unknown }).__boofDevConcierge = devFakeConcierge(mode);
// boof-runner starts only when it is the entry script.
process.argv[1] = fileURLToPath(new URL("../src/boof-runner.ts", import.meta.url));
await import("../src/boof-runner.ts");
