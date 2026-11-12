import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ConciergeBridge, ConciergeBridgeLease } from "@boof/heart";
import type { createConciergeMcpServer } from "../mcp/server.js";

export type ConciergeMcpServer = ReturnType<typeof createConciergeMcpServer>;

interface Entry {
  digest: Buffer;
  make: () => ConciergeMcpServer;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/**
 * Per-turn loopback MCP endpoints for agents that reach the tools over HTTP (claude-code).
 * A lease is one turn: a random turn id and a 256-bit bearer token (only its hash is kept),
 * valid until it is closed. The token is compared in constant time.
 */
export class ConciergeBridgeRegistry {
  private baseUrl: string | null = null;
  private readonly turns = new Map<string, Entry>();

  /** `http://127.0.0.1:<port>` once the server listens on a plain loopback-reachable socket. */
  setBaseUrl(url: string | null): void {
    this.baseUrl = url ? url.replace(/\/+$/, "") : null;
  }

  get ready(): boolean {
    return this.baseUrl !== null;
  }

  get active(): number {
    return this.turns.size;
  }

  /** A bridge for one turn; `open()` makes the endpoint, `close()` removes it. */
  forTurn(make: () => ConciergeMcpServer): { bridge: ConciergeBridge; closeAll: () => void } {
    const leases = new Set<ConciergeBridgeLease>();
    return {
      bridge: {
        open: () => {
          const lease = this.open(make);
          leases.add(lease);
          return lease;
        },
      },
      closeAll: () => {
        for (const lease of leases) lease.close();
        leases.clear();
      },
    };
  }

  open(make: () => ConciergeMcpServer): ConciergeBridgeLease {
    if (!this.baseUrl) throw new Error("the concierge MCP endpoint is not available");
    const turnId = randomUUID();
    const token = randomBytes(32).toString("hex");
    this.turns.set(turnId, { digest: sha256(token), make });
    return {
      url: `${this.baseUrl}/mcp/concierge/${turnId}`,
      token,
      close: () => {
        this.turns.delete(turnId);
      },
    };
  }

  /** The turn's server factory when `token` is the one issued for `turnId`, else null. */
  verify(turnId: string, token: string | undefined): (() => ConciergeMcpServer) | null {
    const entry = this.turns.get(turnId);
    // Compare against a fixed-size digest even when the turn is unknown, so timing is the same.
    const given = sha256(token ?? "");
    const ok = timingSafeEqual(given, entry?.digest ?? Buffer.alloc(32));
    return entry && ok && token ? entry.make : null;
  }
}
