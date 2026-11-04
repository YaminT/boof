import { createHash } from "node:crypto";

/** Fields recorded for a task-creating prompt: a hash and length, never the text. */
export function promptFingerprint(prompt: string): { promptSha256: string; promptLength: number } {
  return {
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    promptLength: prompt.length,
  };
}
