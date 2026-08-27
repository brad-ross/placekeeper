import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { trackRecoveryTemporaryPath } from "./temporary-path-registry.js";

export interface SourceSnapshot {
  readonly path: string;
  readonly digest: string;
  readonly byteLength: number;
}

export interface GenerationOutputIdentity {
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
  readonly byteLength: number;
  readonly modifiedAtMs: number;
}

export interface StagedGenerationSnapshot extends SourceSnapshot {
  readonly outputIdentity: GenerationOutputIdentity;
  readonly finalPath: string;
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

function sameIdentity(
  left: Pick<GenerationOutputIdentity, "device" | "inode" | "byteLength" | "modifiedAtMs">,
  right: Pick<GenerationOutputIdentity, "device" | "inode" | "byteLength" | "modifiedAtMs">,
): boolean {
  return left.device === right.device && left.inode === right.inode &&
    left.byteLength === right.byteLength && left.modifiedAtMs === right.modifiedAtMs;
}

/** Copies one stable regular-file observation into a private generation staging
 * path. The caller structurally validates the staged bytes before finalizing. */
export async function stageGenerationSnapshot(input: {
  readonly sourcePath: string;
  readonly canonicalPath: string;
  readonly sessionDirectory: string;
  readonly generation: number;
  readonly maxBytes: number;
}): Promise<StagedGenerationSnapshot> {
  if (!Number.isSafeInteger(input.generation) || input.generation <= 0) {
    throw new RangeError("Document generation must be a positive safe integer");
  }
  const beforePath = await lstat(input.sourcePath);
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
    throw new Error("The rebuild candidate must be a regular PDF without a symlink");
  }
  if (beforePath.size <= 0 || beforePath.size > input.maxBytes) {
    throw new Error("The rebuild candidate is empty or exceeds the generation limit");
  }
  const before: GenerationOutputIdentity = {
    canonicalPath: input.canonicalPath,
    device: beforePath.dev,
    inode: beforePath.ino,
    byteLength: beforePath.size,
    modifiedAtMs: beforePath.mtimeMs,
  };
  const handle = await open(input.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(before, {
      device: opened.dev,
      inode: opened.ino,
      byteLength: opened.size,
      modifiedAtMs: opened.mtimeMs,
    })) throw new Error("The rebuild candidate changed before its private copy");
    bytes = await handle.readFile();
    const afterHandle = await handle.stat();
    if (!sameIdentity(before, {
      device: afterHandle.dev,
      inode: afterHandle.ino,
      byteLength: afterHandle.size,
      modifiedAtMs: afterHandle.mtimeMs,
    })) throw new Error("The rebuild candidate changed during its private copy");
  } finally {
    await handle.close();
  }
  const afterPath = await lstat(input.sourcePath);
  if (!afterPath.isFile() || afterPath.isSymbolicLink() || !sameIdentity(before, {
    device: afterPath.dev,
    inode: afterPath.ino,
    byteLength: afterPath.size,
    modifiedAtMs: afterPath.mtimeMs,
  })) throw new Error("The rebuild candidate changed after its private copy");
  if (bytes.byteLength !== before.byteLength) {
    throw new Error("The rebuild candidate copy is partial");
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  const generationDirectory = join(input.sessionDirectory, "generations", String(input.generation));
  await ensurePrivateDirectory(generationDirectory);
  const temporaryPath = join(generationDirectory, `.candidate-${randomUUID()}.tmp`);
  const finalPath = join(generationDirectory, `${digest}.pdf`);
  const stopTracking = trackRecoveryTemporaryPath(temporaryPath);
  try {
    const target = await open(temporaryPath, "wx", 0o600);
    try {
      await target.chmod(0o600);
      await target.writeFile(bytes);
      await target.sync();
    } finally {
      await target.close();
    }
    return {
      path: temporaryPath,
      finalPath,
      digest,
      byteLength: bytes.byteLength,
      outputIdentity: before,
    };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  } finally {
    stopTracking();
  }
}

export async function commitGenerationSnapshot(snapshot: StagedGenerationSnapshot): Promise<string> {
  await rename(snapshot.path, snapshot.finalPath);
  await chmod(snapshot.finalPath, 0o600);
  const directoryHandle = await open(dirname(snapshot.finalPath), "r").catch(() => undefined);
  if (directoryHandle !== undefined) {
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }
  return snapshot.finalPath;
}
