import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { constants } from "node:fs";

/** A tar this module cannot trust (bad gzip, bad header, truncated body). */
export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

/** Uncompressed size cap. A gzip bomb stops here instead of filling the disk. */
const MAX_UNCOMPRESSED = 8 * 1024 * 1024 * 1024;
/** One member, so a single entry cannot exhaust memory while it is copied. */
const MAX_ENTRY = 1024 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const MAX_PATH = 4096;

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export interface ArchiveMember {
  /** Path inside the archive, using `/`. */
  path: string;
  kind: "file" | "dir";
  mode: number;
  /** Read the file body from here. Omit for an empty file or a directory. */
  source?: string;
  /** Inline body. Used for the manifest. Ignored when `source` is set. */
  body?: Buffer;
}

export interface RawTarEntry {
  path: string;
  /** USTAR typeflag: `0` file, `2` symlink, `5` directory. */
  typeflag: string;
  mode?: number;
  body?: Buffer;
  /** Symlink target. Backup never writes one; restore tests do. */
  linkname?: string;
}

export type TarKind = "file" | "dir" | "symlink" | "hardlink" | "other";

export interface TarMember {
  path: string;
  kind: TarKind;
  mode: number;
  size: number;
  linkname?: string;
  /** Read a small body (the manifest). At most once. */
  read?: () => Promise<Buffer>;
  /** Copy a file body to `dest` (created exclusively) and return its sha256. At most once. */
  copyTo?: (dest: string) => Promise<string>;
}

interface Member {
  path: string;
  typeflag: string;
  mode: number;
  source?: string;
  body?: Buffer;
  linkname?: string;
}

/**
 * Write a gzip-compressed ustar archive. Names that do not fit the ustar prefix
 * fields are stored with a pax `path` header. The file is created exclusively
 * with mode 0600.
 */
export async function writeTarGz(outFile: string, members: ArchiveMember[]): Promise<void> {
  await writeMembers(
    outFile,
    members.map((member) => ({
      path: member.path,
      typeflag: member.kind === "dir" ? "5" : "0",
      mode: member.mode,
      source: member.source,
      body: member.body,
    })),
  );
}

/**
 * Write an archive that may contain entries backup itself never emits (a `../`
 * path, a symlink). Restore tests use it. The bytes are the same format as
 * {@link writeTarGz}.
 */
export async function writeRawTarGz(outFile: string, entries: RawTarEntry[]): Promise<void> {
  await writeMembers(
    outFile,
    entries.map((entry) => ({
      path: entry.path,
      typeflag: entry.typeflag,
      mode: entry.mode ?? (entry.typeflag === "5" ? 0o755 : 0o644),
      body: entry.body,
      linkname: entry.linkname,
    })),
  );
}

/** Walk a gzip ustar archive. The visitor sees the pax path when one is set. */
export async function readTarGz(
  archive: string,
  visit: (member: TarMember) => Promise<void>,
): Promise<void> {
  const dir = await mkdirTemp();
  const tarPath = join(dir, "archive.tar");
  try {
    await gunzip(archive, tarPath);
    await readTar(tarPath, visit);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function mkdirTemp(): Promise<string> {
  const dir = await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(join(tmpdir(), "boof-tar-")),
  );
  await chmod(dir, 0o700);
  return dir;
}

async function writeMembers(outFile: string, members: Member[]): Promise<void> {
  try {
    await pipeline(
      Readable.from(tarBytes(members)),
      createGzip(),
      createWriteStream(outFile, { flags: "wx", mode: 0o600 }),
    );
    await chmod(outFile, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") await rm(outFile, { force: true });
    throw err instanceof TarError ? err : toTarError(err);
  }
}

async function* tarBytes(members: Member[]): AsyncGenerator<Buffer> {
  for (const member of members) yield* memberBytes(member);
  yield Buffer.alloc(1024);
}

async function* memberBytes(member: Member): AsyncGenerator<Buffer> {
  const split = splitUstar(member.path);
  const linkname = member.linkname ?? "";
  if (Buffer.byteLength(linkname) > 100) {
    throw new TarError("tar link name is longer than 100 bytes");
  }
  if (!split) {
    const pax = paxRecord("path", member.path);
    yield header({
      name: "PaxHeaders.0",
      prefix: "",
      size: pax.length,
      mode: 0o644,
      typeflag: "x",
      linkname: "",
    });
    yield pax;
    yield pad(pax.length);
  }
  const name = split ?? { name: member.path.slice(-100), prefix: "" };
  const size = await memberSize(member);
  yield header({
    name: name.name,
    prefix: name.prefix,
    size,
    mode: member.mode,
    typeflag: member.typeflag,
    linkname,
  });
  if (member.source !== undefined) {
    let left = size;
    for await (const chunk of createReadStream(member.source)) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buf.length > left) throw new TarError(`${member.path} changed while archiving`);
      left -= buf.length;
      yield buf;
    }
    if (left !== 0) throw new TarError(`${member.path} changed while archiving`);
  } else if (member.body !== undefined && member.body.length > 0) {
    yield member.body;
  }
  yield pad(size);
}

async function memberSize(member: Member): Promise<number> {
  if (member.typeflag === "5" || member.typeflag === "2" || member.typeflag === "1") return 0;
  if (member.source !== undefined) {
    const st = await stat(member.source);
    if (!st.isFile()) throw new TarError(`${member.path} is not a regular file`);
    if (st.size > MAX_ENTRY) throw new TarError(`${member.path} is larger than 1 GiB`);
    return st.size;
  }
  return member.body?.length ?? 0;
}

function pad(size: number): Buffer {
  const n = (512 - (size % 512)) % 512;
  return n === 0 ? Buffer.alloc(0) : Buffer.alloc(n);
}

function splitUstar(path: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  if (Buffer.byteLength(path) > 255) return null;
  for (let i = 0; i < path.length; i += 1) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (name.length === 0) continue;
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  return null;
}

function paxRecord(key: string, value: string): Buffer {
  const suffix = Buffer.from(` ${key}=${value}\n`);
  let digits = 1;
  for (;;) {
    const len = digits + suffix.length;
    const text = String(len);
    if (text.length === digits) return Buffer.concat([Buffer.from(text), suffix]);
    digits = text.length;
    if (digits > 12) throw new TarError("pax record is too large");
  }
}

function header(opts: {
  name: string;
  prefix: string;
  size: number;
  mode: number;
  typeflag: string;
  linkname: string;
}): Buffer {
  const buf = Buffer.alloc(512, 0);
  writeStr(buf, 0, opts.name, 100);
  writeOctal(buf, 100, opts.mode & 0o7777, 8);
  writeOctal(buf, 108, 0, 8);
  writeOctal(buf, 116, 0, 8);
  writeOctal(buf, 124, opts.size, 12);
  writeOctal(buf, 136, 0, 12);
  buf.fill(0x20, 148, 156);
  buf[156] = opts.typeflag.charCodeAt(0);
  writeStr(buf, 157, opts.linkname, 100);
  buf.write("ustar", 257, "ascii");
  buf[263] = 0x30;
  buf[264] = 0x30;
  writeStr(buf, 345, opts.prefix, 155);
  const sum = checksum(buf);
  const digits = sum.toString(8).padStart(6, "0");
  if (digits.length > 6) throw new TarError("tar checksum overflow");
  buf.write(digits, 148, "ascii");
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

function writeStr(buf: Buffer, at: number, text: string, field: number): void {
  const bytes = Buffer.from(text);
  if (bytes.length > field) throw new TarError("tar name does not fit in its field");
  bytes.copy(buf, at);
}

function writeOctal(buf: Buffer, at: number, value: number, length: number): void {
  const digits = length - 1;
  const text = value.toString(8).padStart(digits, "0");
  if (text.length > digits) throw new TarError("tar numeric field overflow");
  buf.write(text, at, "ascii");
  buf[at + digits] = 0;
}

function checksum(buf: Buffer): number {
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += buf[i]!;
  return sum;
}

function readStr(buf: Buffer, at: number, length: number): string {
  const field = buf.subarray(at, at + length);
  const nul = field.indexOf(0);
  return (nul === -1 ? field : field.subarray(0, nul)).toString("utf8");
}

function readOctal(buf: Buffer, at: number, length: number): number {
  const text = buf
    .toString("ascii", at, at + length)
    .replace(/\0[\s\S]*$/, "")
    .trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError("archive header has a non-octal numeric field");
  const n = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(n)) throw new TarError("archive header number is too large");
  return n;
}

function storedChecksum(buf: Buffer): number {
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : buf[i]!;
  return sum;
}

function kindOf(flag: number): TarKind | "pax" {
  if (flag === 0 || flag === 0x30) return "file";
  if (flag === 0x35) return "dir";
  if (flag === 0x32) return "symlink";
  if (flag === 0x31) return "hardlink";
  if (flag === 0x78 || flag === 0x58) return "pax";
  return "other";
}

async function gunzip(archive: string, tarPath: string): Promise<void> {
  let total = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > MAX_UNCOMPRESSED) {
        cb(new TarError("archive is larger than 8 GiB uncompressed"));
        return;
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(
      createReadStream(archive),
      createGunzip(),
      cap,
      createWriteStream(tarPath, { flags: "wx", mode: 0o600 }),
    );
  } catch (err) {
    throw err instanceof TarError ? err : toTarError(err);
  }
}

async function readTar(
  tarPath: string,
  visit: (member: TarMember) => Promise<void>,
): Promise<void> {
  const fh = await open(tarPath, constants.O_RDONLY | NOFOLLOW);
  try {
    const size = (await fh.stat()).size;
    let pos = 0;
    let entries = 0;
    let pendingPath: string | undefined;
    while (pos + 512 <= size) {
      const block = Buffer.alloc(512);
      const { bytesRead } = await fh.read(block, 0, 512, pos);
      if (bytesRead !== 512) throw new TarError("truncated archive");
      pos += 512;
      if (block.every((b) => b === 0)) {
        await assertTailZero(fh, pos, size);
        if (pendingPath !== undefined) throw new TarError("pax header without a file");
        return;
      }
      entries += 1;
      if (entries > MAX_ENTRIES) throw new TarError("archive has too many entries");
      if (storedChecksum(block) !== readOctal(block, 148, 8)) {
        throw new TarError("archive header checksum does not match");
      }
      const flag = block[156]!;
      const kind = kindOf(flag);
      const entrySize = readOctal(block, 124, 12);
      if (entrySize > MAX_ENTRY) throw new TarError("an archive entry is larger than 1 GiB");
      const dataPos = pos;
      const padded = Math.ceil(entrySize / 512) * 512;
      if (dataPos + padded > size) throw new TarError("truncated archive");
      pos = dataPos + padded;
      const ustarName = joinPrefix(readStr(block, 345, 155), readStr(block, 0, 100));
      if (kind === "pax") {
        const body = await readRange(fh, dataPos, entrySize);
        const records = parsePax(body);
        if (records.path !== undefined) pendingPath = records.path;
        continue;
      }
      const path = pendingPath ?? ustarName;
      pendingPath = undefined;
      if (path.length > MAX_PATH) throw new TarError("archive path is too long");
      const mode = readOctal(block, 100, 8) & 0o777;
      const linkname = readStr(block, 157, 100);
      let consumed = false;
      const bodyOf = async (): Promise<Buffer> => {
        if (consumed) throw new TarError("entry body already read");
        consumed = true;
        if (entrySize > 32 * 1024 * 1024) throw new TarError("entry is too large to buffer");
        return readRange(fh, dataPos, entrySize);
      };
      const copyTo = async (dest: string): Promise<string> => {
        if (consumed) throw new TarError("entry body already read");
        consumed = true;
        return copyRange(fh, dataPos, entrySize, dest);
      };
      await visit({
        path,
        kind,
        mode,
        size: entrySize,
        ...(linkname ? { linkname } : {}),
        ...(kind === "other" ? { typeflag: String.fromCharCode(flag) } : {}),
        ...(kind === "file"
          ? {
              read: bodyOf,
              copyTo,
            }
          : {}),
      });
    }
    if (pos !== size) throw new TarError("truncated archive");
    if (pendingPath !== undefined) throw new TarError("pax header without a file");
  } finally {
    await fh.close();
  }
}

function joinPrefix(prefix: string, name: string): string {
  if (!prefix) return name;
  return `${prefix}/${name}`;
}

async function assertTailZero(
  fh: Awaited<ReturnType<typeof open>>,
  pos: number,
  size: number,
): Promise<void> {
  const n = size - pos;
  if (n === 0) return;
  const rest = await readRange(fh, pos, n);
  if (rest.some((b) => b !== 0)) throw new TarError("archive has data after the end marker");
}

async function readRange(
  fh: Awaited<ReturnType<typeof open>>,
  pos: number,
  size: number,
): Promise<Buffer> {
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const { bytesRead } = await fh.read(buf, off, size - off, pos + off);
    if (bytesRead === 0) throw new TarError("truncated archive");
    off += bytesRead;
  }
  return buf;
}

async function copyRange(
  fh: Awaited<ReturnType<typeof open>>,
  pos: number,
  size: number,
  dest: string,
): Promise<string> {
  const hash = createHash("sha256");
  const out = await open(
    dest,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    0o600,
  );
  try {
    const buf = Buffer.alloc(Math.min(size, 1024 * 1024));
    let left = size;
    let at = pos;
    while (left > 0) {
      const n = Math.min(left, buf.length);
      const { bytesRead } = await fh.read(buf, 0, n, at);
      if (bytesRead !== n) throw new TarError("truncated archive");
      const slice = buf.subarray(0, bytesRead);
      hash.update(slice);
      await writeAll(out, slice);
      left -= bytesRead;
      at += bytesRead;
    }
  } finally {
    await out.close();
  }
  return hash.digest("hex");
}

async function writeAll(fh: Awaited<ReturnType<typeof open>>, buf: Buffer): Promise<void> {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf.subarray(off));
    if (bytesWritten <= 0) throw new TarError("short write");
    off += bytesWritten;
  }
}

function parsePax(body: Buffer): { path?: string } {
  const out: { path?: string } = {};
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp < 0) throw new TarError("bad pax header");
    const len = Number(body.toString("utf8", i, sp));
    if (!Number.isInteger(len) || len < 5 || i + len > body.length) {
      throw new TarError("bad pax header");
    }
    const record = body.subarray(i, i + len);
    if (record[record.length - 1] !== 0x0a) throw new TarError("bad pax header");
    const eq = record.indexOf(0x3d);
    if (eq <= sp - i) throw new TarError("bad pax header");
    const key = record.toString("utf8", sp - i + 1, eq);
    const value = record.toString("utf8", eq + 1, record.length - 1);
    if (key === "path") out.path = value;
    i += len;
  }
  return out;
}

function toTarError(err: unknown): TarError {
  return new TarError(err instanceof Error ? err.message : String(err));
}
