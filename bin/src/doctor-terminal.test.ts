import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const created: Record<string, unknown>[] = [];
const rls: EventEmitter[] = [];
vi.mock("node:readline", () => ({
  createInterface: (opts: Record<string, unknown>) => {
    created.push(opts);
    const rl = new EventEmitter() as EventEmitter & { close(): void; question(): void };
    rl.close = () => void rl.emit("close");
    rl.question = () => {};
    rls.push(rl);
    return rl;
  },
}));

import { DoctorCancelled, terminalIo } from "./doctor-cli.js";

describe("terminalIo", () => {
  it("keeps no readline history, so a hidden answer cannot come back with the Up arrow", () => {
    terminalIo().close();
    expect(created.at(-1)?.historySize).toBe(0);
    expect(created.at(-1)?.terminal).toBe(true);
  });

  it("a closed terminal (Ctrl-C, Ctrl-D) ends the waiting question with DoctorCancelled", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const io = terminalIo();
    const pending = io.ask("Question? ");
    rls.at(-1)?.emit("SIGINT"); // Ctrl-C closes the readline interface
    await expect(pending).rejects.toBeInstanceOf(DoctorCancelled);
    vi.restoreAllMocks();
  });
});
