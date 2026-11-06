export * from "./api/index.js";
export * from "./mcp/index.js";
export * from "./server/index.js";
// Scripted assistant for tests and the dev-only `BOOF_DEV_FAKE_CONCIERGE` wiring in bin.
export { scriptedAgent, type ScriptStep } from "./concierge/fake-agent.js";
