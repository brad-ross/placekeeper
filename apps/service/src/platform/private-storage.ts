import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { requestWindowsNative } from "./windows-native-worker.js";
async function windowsPrivacy(path: string, establish: boolean): Promise<void> {
  await requestWindowsNative({ operation: establish ? "protect" : "verify", path });
}

export async function verifyPrivatePath(path: string, kind: "file" | "directory"): Promise<void> {
  const info = await lstat(path);
  if (kind === "file" ? !info.isFile() : !info.isDirectory()) throw new Error("Private storage has an unexpected file type");
  if (process.platform === "win32") return windowsPrivacy(path, false);
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("Private storage permissions are unsafe");
}

function nativeCreationFailure(nativeCode: number): Error {
  return Object.assign(new Error(`Windows private storage creation failed (${nativeCode})`), {
    code: nativeCode === 80 || nativeCode === 183 ? "EEXIST" : nativeCode === 5 ? "EACCES" : nativeCode === 2 || nativeCode === 3 ? "ENOENT" : "EIO",
    nativeCode,
  });
}
export async function ensurePrivateDirectory(path: string): Promise<void> {
  if (process.platform === "win32") {
    const result = await requestWindowsNative({ operation: "createPrivateDirectory", path });
    if (result.status === "failed" && result.nativeCode !== 80 && result.nativeCode !== 183) throw nativeCreationFailure(result.nativeCode);
  } else {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  await verifyPrivatePath(path, "directory");
}

/** Creates an empty exclusive file with privacy established at creation time. */
export async function createPrivateFile(path: string): Promise<void> {
  if (process.platform === "win32") {
    const result = await requestWindowsNative({ operation: "createPrivateFile", path });
    if (result.status === "failed") throw nativeCreationFailure(result.nativeCode);
    await verifyPrivatePath(path, "file");
  } else {
    const handle = await open(path, "wx", 0o600); await handle.close();
  }
}
export async function writePrivateFile(path: string, bytes: string | Uint8Array | AsyncIterable<Uint8Array>): Promise<void> {
  await verifyPrivatePath(dirname(path), "directory");
  if (process.platform === "win32") await createPrivateFile(path);
  const handle = await open(path, process.platform === "win32" ? "r+" : "wx", 0o600);
  try {
    if (process.platform !== "win32") await chmod(path, 0o600);
    await verifyPrivatePath(path, "file");
    if (typeof bytes === "string" || bytes instanceof Uint8Array) await handle.writeFile(bytes);
    else for await (const chunk of bytes) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten <= 0) throw new Error("Private storage write made no progress");
        offset += bytesWritten;
      }
    }
    await handle.sync();
  } finally { await handle.close(); }
}

export async function readPrivateFile(path: string, maxBytes: number): Promise<Buffer> {
  await verifyPrivatePath(dirname(path), "directory");
  await verifyPrivatePath(path, "file");
  const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Private storage has an unexpected file type");
    if (info.size > maxBytes) throw new Error("Private storage file is oversized");
    const bytes = Buffer.alloc(info.size + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const next = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (next.bytesRead === 0) break;
      bytesRead += next.bytesRead;
    }
    if (bytesRead > maxBytes) throw new Error("Private storage file is oversized");
    const unchanged = (current: typeof info) => current.ino === info.ino && current.dev === info.dev &&
      current.size === info.size && current.mtimeMs === info.mtimeMs && current.ctimeMs === info.ctimeMs;
    if (bytesRead !== info.size || !unchanged(await handle.stat())) throw new Error("Private storage changed while reading");
    await verifyPrivatePath(path, "file");
    const current = await lstat(path);
    if (!unchanged(current)) throw new Error("Private storage identity changed");
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

/** For an empty directory just created exclusively by the caller. */
export async function establishPrivateDirectory(path: string): Promise<void> {
  if (process.platform === "win32") await windowsPrivacy(path, true);
  await verifyPrivatePath(path, "directory");
}
