import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aclNeedsTighten,
  canonicalSid,
  decodeIcaclsText,
  extractDacl,
  isFilesystemRoot,
  parentLetsOthersWrite,
  parseIcaclsSave,
  parseWhoamiCsv,
  rightsIncludeWrite,
  windowsAclFromRunner,
  type AclAce,
  type CommandResult,
  type CommandRunner,
} from "./windows-acl.js";

const me = "S-1-5-21-1";
const userAce = (extra: Partial<AclAce> = {}): AclAce => ({
  sid: me,
  allow: true,
  inherited: false,
  inheritOnly: false,
  rights: "FA",
  ...extra,
});

describe("SDDL access lists", () => {
  it("reads the DACL even when the owner and a SID sit on the same line", () => {
    const line = "O:SYG:SYD:P(A;OICI;FA;;;S-1-5-21-1)S:(AU;SA;FA;;;WD)";
    expect(extractDacl(line)).toBe("P(A;OICI;FA;;;S-1-5-21-1)");
    expect(parseIcaclsSave(`data\n${line}\n`).aces).toEqual([
      { sid: me, allow: true, inherited: false, inheritOnly: false, rights: "FA" },
    ]);
  });

  it("decodes the UTF-16 LE file icacls /save writes", () => {
    const text = "data\r\nD:P(A;;FR;;;WD)\r\n";
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    expect(decodeIcaclsText(buf)).toBe(text);
    expect(parseIcaclsSave(decodeIcaclsText(buf)).aces[0]).toMatchObject({
      sid: "WD",
      allow: true,
      rights: "FR",
    });
  });

  it("treats aliases and hex masks as write or not", () => {
    expect(canonicalSid("wd")).toBe("S-1-1-0");
    expect(canonicalSid("SY")).toBe("S-1-5-18");
    expect(canonicalSid(me)).toBe(me);
    expect(rightsIncludeWrite("FA")).toBe(true);
    expect(rightsIncludeWrite("FR")).toBe(false);
    expect(rightsIncludeWrite("0x1200a9")).toBe(false);
    expect(rightsIncludeWrite("0x1F01FF")).toBe(true);
  });

  it("needs a rewrite for other accounts, inheritance, and a missing user write", () => {
    expect(aclNeedsTighten([userAce()], me)).toBe(false);
    expect(aclNeedsTighten([userAce(), userAce({ sid: "WD", rights: "FR" })], me)).toBe(true);
    expect(aclNeedsTighten([userAce({ inherited: true })], me)).toBe(true);
    expect(aclNeedsTighten([userAce({ inheritOnly: true })], me)).toBe(true);
    expect(
      aclNeedsTighten([userAce({ allow: false, rights: "FW" }), userAce({ rights: "FR" })], me),
    ).toBe(true);
    expect(aclNeedsTighten([], me)).toBe(true);
  });

  it("flags a shared parent and ignores SYSTEM and Administrators", () => {
    expect(
      parentLetsOthersWrite([userAce({ sid: "SY" }), userAce({ sid: "BA" }), userAce()], me),
    ).toBeNull();
    expect(parentLetsOthersWrite([userAce({ sid: "WD" })], me)).toBe("S-1-1-0");
    expect(parentLetsOthersWrite([userAce({ sid: "BU" })], me)).toBe("S-1-5-32-545");
    expect(parentLetsOthersWrite([userAce({ sid: "WD", inheritOnly: true })], me)).toBeNull();
    expect(parentLetsOthersWrite([userAce({ sid: "WD", rights: "FR" })], me)).toBeNull();
  });

  it("knows a drive root and a filesystem root", () => {
    expect(isFilesystemRoot("/")).toBe(true);
    expect(isFilesystemRoot("\\")).toBe(true);
    expect(isFilesystemRoot("C:\\")).toBe(true);
    expect(isFilesystemRoot("C:")).toBe(true);
    expect(isFilesystemRoot("C:\\Users\\me")).toBe(false);
    expect(isFilesystemRoot("/tmp/data")).toBe(false);
  });

  it("parses whoami /user csv", () => {
    expect(parseWhoamiCsv('"DESKTOP\\me","S-1-5-21-9"\r\n')).toEqual({
      account: "DESKTOP\\me",
      sid: "S-1-5-21-9",
    });
    expect(parseWhoamiCsv("not a user")).toBeNull();
  });
});

describe("icacls command sequence", () => {
  const files: string[] = [];
  afterEach(async () => {
    await Promise.all(files.splice(0).map((file) => rm(file, { recursive: true, force: true })));
  });

  it("grants the user, drops inheritance, and removes every other SID", async () => {
    const saves = [
      "data\nD:P(A;OICI;FA;;;S-1-5-21-1)(A;;FA;;;WD)(A;;FA;;;SY)\n",
      "data\nD:P(A;OICI;FA;;;S-1-5-21-1)\n",
    ];
    const commands: string[][] = [];
    const run: CommandRunner = async (command, args) => {
      commands.push([command, ...args]);
      if (command === "whoami") {
        return { code: 0, stdout: '"DESKTOP\\me","S-1-5-21-1"\r\n', stderr: "" };
      }
      const saveAt = args.indexOf("/save");
      if (saveAt >= 0) {
        const file = args[saveAt + 1]!;
        files.push(file);
        await writeFile(file, saves.shift() ?? "");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const acl = windowsAclFromRunner(run);
    const user = await acl.currentUser();
    expect(user).toEqual({ account: "DESKTOP\\me", sid: "S-1-5-21-1" });
    const root = await mkdtemp(join(tmpdir(), "boof-acl-"));
    files.push(root);
    expect(await acl.tightenToUser(root, user!)).toBe(true);
    const icacls = commands.filter((argv) => argv[0] === "icacls").map((argv) => argv.slice(1));
    expect(icacls[0]).toEqual([root, "/grant:r", "*S-1-5-21-1:(OI)(CI)F", "/C", "/Q"]);
    expect(icacls[1]).toEqual([root, "/inheritance:r", "/C", "/Q"]);
    expect(icacls[2]?.[1]).toBe("/save");
    expect(icacls[3]).toEqual([root, "/remove", "*S-1-1-0", "/C", "/Q"]);
    expect(icacls[4]).toEqual([root, "/remove", "*S-1-5-18", "/C", "/Q"]);
    expect(icacls[5]?.[1]).toBe("/save");
    const quiet: CommandResult = { code: 0, stdout: "", stderr: "" };
    expect(
      await windowsAclFromRunner(async () => ({ ...quiet, code: 1 })).currentUser(),
    ).toBeNull();
  });
});
