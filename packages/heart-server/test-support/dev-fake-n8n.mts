// Starts the fake n8n with three workflows and prints its URL and API key, for UI screenshots.
// Usage: npx tsx packages/heart-server/test-support/dev-fake-n8n.mts
import { fakeWorkflow, startFakeN8n } from "./fake-n8n.ts";

const apiKey = "dev-n8n-key";
const fake = await startFakeN8n({
  apiKey,
  workflows: [
    fakeWorkflow({ id: "wf-lint", name: "Lint and notify", webhook: { path: "boof-lint-3f9a1c" } }),
    fakeWorkflow({
      id: "wf-poll",
      name: "Poll a feed",
      webhook: { path: "poll-feed", method: "GET" },
    }),
    fakeWorkflow({ id: "wf-manual", name: "Manual cleanup", webhook: null }),
  ],
});
console.log(`n8n URL: ${fake.url}`);
console.log(`n8n API key: ${apiKey}`);
console.log("Press Ctrl+C to stop.");
process.on("SIGINT", () => void fake.close().then(() => process.exit(0)));
