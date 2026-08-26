import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { trackRecoveryTemporaryPath } from "./temporary-path-registry.js";

export interface SourceSnapshot {
  readonly path: string;
  readonly digest: string;
  readonly byteLength: number;
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function createSourceSnapshot(
  sourcePath: string,
  sessionDirectory: string,
): Promise<SourceSnapshot> {
  await ensurePrivateDirectory(sessionDirectory);
  const bytes = await readFile(sourcePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const finalPath = join(sessionDirectory, "source.pdf");
  const temporaryPath = join(sessionDirectory, `.source-${randomUUID()}.tmp`);
  const stopTracking = trackRecoveryTemporaryPath(temporaryPath);
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, finalPath);
    await chmod(finalPath, 0o600);
    const directoryHandle = await open(sessionDirectory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    const info = await stat(finalPath);
    return { path: finalPath, digest, byteLength: info.size };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  } finally {
    stopTracking();
  }
}
