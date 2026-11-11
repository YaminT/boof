/**
 * Temporary Windows CI diagnostic for the data-folder access check.
 * Dumps icacls /save for a fresh temp directory and its parent. Removed after the fix.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  aclNeedsTighten,
  decodeIcaclsText,
  parentLetsOthersWrite,
  parseIcaclsSave,
  windowsAclFromRunner,
} from "./windows-acl.js";

const execFileAsync = promisify(execFile);

async function dump(label: string, dir: string): Promise<void> {
  const file = join(tmpdir(), `boof-acl-diag-${label}-${process.pid}.txt`);
  let code = 0;
  let stdout = "";
  let stderr = "";
  try {
    const res = await execFileAsync("icacls", [dir, "/save", file, "/C", "/Q"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    stdout = res.stdout;
    stderr = res.stderr;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    code = typeof err.code === "number" ? err.code : 1;
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? err.message;
  }
  let buf = Buffer.alloc(0);
  try {
    buf = await readFile(file);
  } catch (error) {
    console.log(`READ_FAIL ${label} ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = decodeIcaclsText(buf);
  const parsed = parseIcaclsSave(text);
  console.log(`=== ${label}`);
  console.log(`PATH ${dir}`);
  console.log(`ICACLS_CODE ${code}`);
  console.log(`ICACLS_STDOUT ${JSON.stringify(stdout)}`);
  console.log(`ICACLS_STDERR ${JSON.stringify(stderr)}`);
  console.log(`BYTES ${buf.length}`);
  console.log(`HEX200 ${buf.subarray(0, 200).toString("hex")}`);
  console.log("DECODED_BEGIN");
  console.log(text);
  console.log("DECODED_END");
  console.log(`PARSED ${JSON.stringify(parsed)}`);
  await rm(file, { force: true }).catch(() => {});
}

const dir = await mkdtemp(join(tmpdir(), "boof-acl-diag-"));
try {
  const acl = windowsAclFromRunner();
  const user = await acl.currentUser();
  console.log(`USER ${JSON.stringify(user)}`);
  console.log(`TMPDIR ${tmpdir()}`);
  await dump("fresh", dir);
  await dump("parent", dirname(dir));
  const fresh = await acl.readAcl(dir);
  const parent = await acl.readAcl(dirname(dir));
  console.log(`PRODUCT_FRESH ${JSON.stringify(fresh)}`);
  console.log(`PRODUCT_PARENT ${JSON.stringify(parent)}`);
  if (user && fresh.ok) {
    console.log(`NEEDS_TIGHTEN ${aclNeedsTighten(fresh.aces, user.sid)}`);
    console.log(
      `NEEDS_TIGHTEN_INHERITED ${aclNeedsTighten(fresh.aces, user.sid, { acceptInheritedUser: true })}`,
    );
    console.log(`FRESH_OTHERS ${parentLetsOthersWrite(fresh.aces, user.sid)}`);
  }
  if (user && parent.ok) {
    console.log(`PARENT_LETS ${parentLetsOthersWrite(parent.aces, user.sid)}`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
