// Copy the Linux helper into the staged app. Other systems have no boof-sandbox binary.
import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {{ platform?: string, helper: string, appDir: string }} options
 * @returns {string | null} destination path, or null when this platform does not ship the helper
 */
export function copyLinuxSandboxHelper(options) {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return null;
  if (!existsSync(options.helper)) {
    throw new Error(
      `stage-app: missing ${options.helper}\n  -> run \`node packages/sandbox-linux/build.mjs\` first`,
    );
  }
  const dest = join(options.appDir, "boof-sandbox");
  copyFileSync(options.helper, dest);
  chmodSync(dest, 0o755);
  return dest;
}
