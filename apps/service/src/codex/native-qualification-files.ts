import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";

/** Fixed read budget even if an owner file grows after fstat. Nonblocking open
 * rejects FIFOs/devices before reading, so diagnostics cannot stall admission. */
export function readQualificationDescriptor(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 || stat.size > 2048) throw new Error("invalid-descriptor");
    const buffer = Buffer.alloc(2048);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = readSync(fd, buffer, { offset: bytes, length: buffer.length - bytes, position: bytes });
      if (read === 0) break;
      bytes += read;
    }
    // Refuse growth/truncation during the read as well as overflow. No unbounded
    // readFile operation may precede these checks.
    if (bytes !== stat.size || fstatSync(fd).size !== stat.size) throw new Error("invalid-descriptor");
    return buffer.subarray(0, bytes).toString("utf8");
  } finally { closeSync(fd); }
}

/** Owner-only directories shared by the qualification observer and controls. */
export function qualificationDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  assertQualificationDirectory(path);
}
/** Read-only check for existing descriptor parents. */
export function assertQualificationDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700) throw new Error("invalid-directory");
}

/** Exclusive immutable small record. An interrupted write is a permanent uncertain
 * record, never deleted or retried. O_NONBLOCK keeps hostile file types harmless. */
export function createQualificationRecord(path: string, value: unknown): boolean {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 2048) throw new Error("record-too-large");
  let fd: number;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) throw new Error("invalid-record");
    if (writeSync(fd, text) !== Buffer.byteLength(text)) throw new Error("partial-record");
  } finally { closeSync(fd); }
  return true;
}
/** Only ENOENT is absence. Existing unreadable/hostile/partial state is uncertain. */
export function readQualificationRecord(path: string): unknown | undefined {
  try { return JSON.parse(readQualificationDescriptor(path)) as unknown; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
