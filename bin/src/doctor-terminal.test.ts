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

  it("after Ctrl-C every later question and install ends with DoctorCancelled, not ERR_USE_AFTER_CLOSE", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const io = terminalIo();
    rls.at(-1)?.emit("SIGINT");
    await expect(io.ask("Again? ")).rejects.toBeInstanceOf(DoctorCancelled);
    await expect(io.run("npm", ["--version"])).rejects.toBeInstanceOf(DoctorCancelled);
    vi.restoreAllMocks();
  });

  it("Ctrl-C while an install runs stops it and the next question is cancelled", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const io = terminalIo();
    const running = io.run(process.execPath, ["-e", "setTimeout(()=>{},30000)"]);
    await new Promise((r) => setTimeout(r, 200));
    rls.at(-1)?.emit("SIGINT");
    expect(await running).not.toBe(0);
    await expect(io.ask("Next? ")).rejects.toBeInstanceOf(DoctorCancelled);
    vi.restoreAllMocks();
  });
});
