import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aclNeedsTighten,
  canonicalSid,
  sameAccount,
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
      {
        sid: me,
        allow: true,
        inherited: false,
        inheritOnly: false,
        rights: "FA",
        conditional: false,
      },
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

  it("detects UTF-16 LE icacls output without a BOM", () => {
    const text = "data\r\nD:P(A;;FR;;;WD)\r\n";
    const buf = Buffer.from(text, "utf16le");
    expect(decodeIcaclsText(buf)).toBe(text);
    expect(parseIcaclsSave(decodeIcaclsText(buf))).toMatchObject({
      ok: true,
      aces: [{ sid: "WD", allow: true, rights: "FR" }],
    });
  });

  it("treats aliases and hex masks as write or not", () => {
    expect(canonicalSid("wd")).toBe("S-1-1-0");
    expect(canonicalSid("SY")).toBe("S-1-5-18");
    expect(canonicalSid(me)).toBe(me);
    expect(rightsIncludeWrite("FA")).toBe(true);
    expect(rightsIncludeWrite("FR")).toBe(false);
    expect(rightsIncludeWrite("LC")).toBe(false);
    expect(rightsIncludeWrite("DT")).toBe(true);
    expect(rightsIncludeWrite("CR")).toBe(true);
    expect(rightsIncludeWrite("LCDT")).toBe(true);
    expect(rightsIncludeWrite("0x1200a9")).toBe(false);
    expect(rightsIncludeWrite("0x40")).toBe(true);
    expect(rightsIncludeWrite("0x1F01FF")).toBe(true);
  });

  it("needs a rewrite for other accounts, inheritance, and a missing user write", () => {
    expect(aclNeedsTighten([userAce()], me)).toBe(false);
    expect(aclNeedsTighten([userAce(), userAce({ sid: "WD", rights: "FR" })], me)).toBe(true);
    // The owner's own inherited allow is the directory they just created. Another account is not.
    expect(aclNeedsTighten([userAce({ inherited: true })], me)).toBe(false);
    expect(aclNeedsTighten([userAce({ sid: "BU", inherited: true })], me)).toBe(true);
    expect(aclNeedsTighten([userAce({ inheritOnly: true })], me)).toBe(true);
    expect(
      aclNeedsTighten([userAce({ allow: false, rights: "FW" }), userAce({ rights: "FR" })], me),
    ).toBe(true);
    expect(aclNeedsTighten([], me)).toBe(true);
  });

  it("accepts an inherited full-control ACE for the current user on a child, and nothing else", () => {
    const folder = parseIcaclsSave("child\nD:AI(A;OICIID;FA;;;S-1-5-21-1)\n");
    const file = parseIcaclsSave("child\nD:AI(A;ID;FA;;;S-1-5-21-1)\n");
    expect(folder.ok && file.ok).toBe(true);
    if (!folder.ok || !file.ok) return;
    expect(folder.aces).toEqual([
      {
        sid: me,
        allow: true,
        inherited: true,
        inheritOnly: false,
        rights: "FA",
        conditional: false,
      },
    ]);
    for (const aces of [folder.aces, file.aces]) {
      expect(aclNeedsTighten(aces, me)).toBe(false);
      expect(aclNeedsTighten(aces, me, { acceptInheritedUser: true })).toBe(false);
    }
    const wider = parseIcaclsSave("child\nD:AI(A;OICIID;FA;;;S-1-5-21-1)(A;OICIID;FR;;;WD)\n");
    expect(wider.ok).toBe(true);
    if (!wider.ok) return;
    expect(aclNeedsTighten(wider.aces, me, { acceptInheritedUser: true })).toBe(true);
    const readOnly = parseIcaclsSave("child\nD:AI(A;OICIID;FR;;;S-1-5-21-1)\n");
    expect(readOnly.ok).toBe(true);
    if (!readOnly.ok) return;
    expect(aclNeedsTighten(readOnly.aces, me, { acceptInheritedUser: true })).toBe(true);
  });

  it("treats conditional ACEs as unsafe without evaluating them", () => {
    const simple = parseIcaclsSave(
      'data\nD:(XA;;FA;;;WD;(@User.Title=="PM"))(A;;FA;;;S-1-5-21-1)\n',
    );
    expect(simple.ok).toBe(true);
    if (!simple.ok) return;
    expect(simple.aces.some((ace) => ace.conditional)).toBe(true);
    expect(aclNeedsTighten(simple.aces, me)).toBe(true);
    expect(aclNeedsTighten(simple.aces, me, { acceptInheritedUser: true })).toBe(true);
    expect(parentLetsOthersWrite(simple.aces, me)).toBe("conditional");

    const nested = parseIcaclsSave("data\nD:(ZA;;0x40;;;S-1-5-21-1;(Member_of {SID(S-1-5-21)}))\n");
    expect(nested.ok).toBe(true);
    if (!nested.ok) return;
    expect(nested.aces.some((ace) => ace.conditional)).toBe(true);
    expect(aclNeedsTighten(nested.aces, me, { acceptInheritedUser: true })).toBe(true);
    expect(parentLetsOthersWrite(nested.aces, me)).toBe("conditional");
  });

  it("flags a shared parent and ignores SYSTEM and Administrators", () => {
    expect(
      parentLetsOthersWrite([userAce({ sid: "SY" }), userAce({ sid: "BA" }), userAce()], me),
    ).toBeNull();
    expect(parentLetsOthersWrite([userAce({ sid: "WD" })], me)).toBe("S-1-1-0");
    expect(parentLetsOthersWrite([userAce({ sid: "BU" })], me)).toBe("S-1-5-32-545");
    expect(parentLetsOthersWrite([userAce({ sid: "AU" })], me)).toBe("S-1-5-11");
    expect(parentLetsOthersWrite([userAce({ sid: "WD", inheritOnly: true })], me)).toBeNull();
    expect(parentLetsOthersWrite([userAce({ sid: "WD", rights: "FR" })], me)).toBeNull();
  });

  it("treats LA as the user only when that user is the built-in Administrator", () => {
    const admin = "S-1-5-21-3289802278-1561746829-1498425070-500";
    const other = "S-1-5-21-3289802278-1561746829-1498425070-1001";
    // The bytes icacls /save wrote for a new directory under the GitHub runner temp folder.
    const text = "boof-acl-diag\r\nD:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)\r\n";
    const buf = Buffer.from(text, "utf16le");
    expect(decodeIcaclsText(buf)).toBe(text);
    const parsed = parseIcaclsSave(decodeIcaclsText(buf));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(sameAccount("LA", admin)).toBe(true);
    expect(sameAccount("LA", other)).toBe(false);
    expect(sameAccount("LA", me)).toBe(false);
    expect(aclNeedsTighten(parsed.aces, admin)).toBe(false);
    expect(aclNeedsTighten(parsed.aces, other)).toBe(true);
    expect(parentLetsOthersWrite(parsed.aces, admin)).toBeNull();
    expect(parentLetsOthersWrite(parsed.aces, other)).toBe("LA");
    const inherited = parseIcaclsSave(
      "child\nD:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;LA)\n",
    );
    expect(inherited.ok).toBe(true);
    if (!inherited.ok) return;
    expect(aclNeedsTighten(inherited.aces, admin)).toBe(false);
    for (const foreign of ["BU", "WD", "AU"]) {
      expect(
        aclNeedsTighten([...parsed.aces, userAce({ sid: foreign, rights: "FA" })], admin),
      ).toBe(true);
      expect(
        parentLetsOthersWrite([...parsed.aces, userAce({ sid: foreign, rights: "FA" })], admin),
      ).toBe(canonicalSid(foreign));
    }
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
