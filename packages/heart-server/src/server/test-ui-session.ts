import type { BrowserSession, BrowserSessionVerifier } from "@boof/heart";

/** TEST ONLY. Every keyless loopback request counts as the signed-in web UI (the pre-layer-1 behaviour). */
export const TEST_LOOPBACK_IS_UI: BrowserSessionVerifier = {
  async verify(_token: string | undefined): Promise<BrowserSession> {
    return {
      id: "test-ui",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  },
};
