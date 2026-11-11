// The staged app may contain one native binary: boof-sandbox, at the app root, and nothing else.
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ALLOWED = "boof-sandbox";

function walk(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const full = join(path, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** ELF, PE, or Mach-O. Other files (JS, HTML, PNG) are not native binaries. */
export function isNativeBinary(path) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  const buf = Buffer.alloc(4);
  try {
    if (readSync(fd, buf, 0, 4, 0) < 4) return false;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true;
  if (buf[0] === 0x4d && buf[1] === 0x5a) return true;
  const be = buf.readUInt32BE(0);
  const le = buf.readUInt32LE(0);
  return (
    be === 0xfeedface ||
    be === 0xfeedfacf ||
    be === 0xcafebabe ||
    be === 0xcafebabf ||
    le === 0xfeedface ||
    le === 0xfeedfacf
  );
}

/**
 * Linux must ship boof-sandbox and no other native file. Other systems must ship none.
 * @param {string} appDir
 * @param {NodeJS.Platform} [platform]
 */
export function assertStagedNative(appDir, platform = process.platform) {
  let helper = false;
  const bad = [];
  for (const path of walk(appDir)) {
    let info;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (!info.isFile() || !isNativeBinary(path)) continue;
    if (relative(appDir, path) === ALLOWED) {
      helper = true;
      continue;
    }
    bad.push(path);
  }
  if (bad.length > 0) {
    throw new Error(`staged app has a native file other than boof-sandbox:\n${bad.join("\n")}`);
  }
  if (platform === "linux" && !helper) {
    throw new Error(`staged app is missing boof-sandbox (${join(appDir, ALLOWED)})`);
  }
}
