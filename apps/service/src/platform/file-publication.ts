import { randomUUID } from "node:crypto";
import { chmod, link, open, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { syncDirectory } from "../files/durability.js";
import { createPrivateFile } from "./private-storage.js";
import { requestWindowsNative, WindowsNativeWorkerError } from "./windows-native-worker.js";

/** A sibling avoids relying on device numbers identifying Windows volumes. */
export async function stagePublication(target: string, bytes: Uint8Array): Promise<string> {
  const path = join(dirname(target), `.placekeeper-${randomUUID()}.tmp`);
  let created = false;
  try {
    if (process.platform === "win32") {
      await createPrivateFile(path);
      created = true;
    }
    const handle = await open(path, process.platform === "win32" ? "r+" : "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return path;
  } catch (error) {
    if (created) await rm(path, { force: true });
    throw error;
  }
}

/** Run before the caller's last generation/revision fence. Failure leaves the
 * original untouched. Windows chmod cannot preserve a discretionary ACL. */
export async function preserveReplacementPermissions(candidate: string, original: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(candidate, (await stat(original)).mode & 0o777);
    return;
  }
  const result = await requestWindowsNative({ operation: "copyAcl", candidate, original });
  if (result.status !== "ok") throw new Error("Replacement security descriptor was not preserved");
}

export interface FilePublication {
  readonly target: string;
  /** False means the native process ended without a conclusive result. */
  readonly confirmed: boolean;
  readonly windowsWriteThrough: boolean;
}

/** Never remove the target or fall back to a copy/delete operation. The native
 * Windows operation requests write-through; POSIX callers sync the directory.
 * https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-movefileexw */
export async function publishFile(candidate: string, target: string, options: { readonly replaceExisting?: boolean } = {}): Promise<FilePublication> {
  if (resolve(dirname(candidate)) !== resolve(dirname(target))) {
    throw new Error("Publication requires a candidate in the destination directory");
  }
  if (process.platform !== "win32") {
    if (options.replaceExisting === false) {
      await link(candidate, target);
      await unlink(candidate);
    } else await rename(candidate, target);
    return { target, confirmed: true, windowsWriteThrough: false };
  }
  let result;
  try {
    result = await requestWindowsNative({ operation: "publish", candidate, target,
      replaceExisting: options.replaceExisting !== false });
  } catch (error) {
    if (!(error instanceof WindowsNativeWorkerError) || !error.uncertain) throw error;
    return { target, confirmed: false, windowsWriteThrough: false };
  }
  if (result.status === "failed") {
    const nativeCode = result.nativeCode;
    throw Object.assign(new Error(`Windows file publication failed (${nativeCode})`), {
      code: nativeCode === 2 || nativeCode === 3 ? "ENOENT" : nativeCode === 5 ? "EACCES" : nativeCode === 32 || nativeCode === 33 ? "EBUSY" : nativeCode === 80 || nativeCode === 183 ? "EEXIST" : "EIO",
      nativeCode,
    });
  }
  const confirmed = result.status === "published";
  return { target, confirmed, windowsWriteThrough: confirmed };
}

/** This is deliberately distinct from generic directory fsync: Windows may
 * omit it only for this specific confirmed write-through rename. */
export async function syncPublishedFile(publication: FilePublication): Promise<void> {
  if (!publication.confirmed) throw new Error("File publication could not be confirmed");
  if (process.platform === "win32" && publication.windowsWriteThrough) return;
  await syncDirectory(dirname(publication.target));
}
