import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
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

export interface SyncTexSidecarFingerprint {
  readonly digest: string;
  readonly byteLength: number;
  readonly device: number;
  readonly inode: number;
  readonly modifiedAtMs: number;
  readonly compressed: boolean;
}

export interface GenerationSyncTexSnapshot {
  readonly snapshotPath: string;
  readonly fingerprint: SyncTexSidecarFingerprint;
}

export type GenerationSyncTexSnapshotResult =
  | { readonly status: "ready"; readonly snapshot: GenerationSyncTexSnapshot }
  | { readonly status: "missing" | "ambiguous" | "stale"; readonly reason: string };

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function createSourceSnapshot(
  sourcePath: string,
  sessionDirectory: string,
): Promise<SourceSnapshot> {
  const bytes = await readFile(sourcePath);
  if (bytes.byteLength === 0) {
    throw new Error("The PDF is empty. Wait for the rebuild to finish, then reopen it in Placekeeper.");
  }
  await ensurePrivateDirectory(sessionDirectory);
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

function identityFromStat(canonicalPath: string, info: Stats): GenerationOutputIdentity {
  return {
    canonicalPath,
    device: info.dev,
    inode: info.ino,
    byteLength: info.size,
    modifiedAtMs: info.mtimeMs,
  };
}

async function currentOutputMatches(
  outputPath: string,
  expectedIdentity: GenerationOutputIdentity,
  expectedDigest: string,
): Promise<boolean> {
  const before = await lstat(outputPath).catch(() => undefined);
  if (
    before === undefined || !before.isFile() || before.isSymbolicLink() ||
    !sameIdentity(expectedIdentity, identityFromStat(expectedIdentity.canonicalPath, before))
  ) return false;
  const handle = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (handle === undefined) return false;
  try {
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    const afterHandle = await handle.stat();
    if (!sameIdentity(expectedIdentity, identityFromStat(expectedIdentity.canonicalPath, afterHandle))) {
      return false;
    }
    return digest.digest("hex") === expectedDigest;
  } finally {
    await handle.close();
  }
}

/** Copies a stable `.synctex` or `.synctex.gz` observation beside the private
 * PDF snapshot. The mutable output and sidecar are both re-fenced, so queries
 * never run against the build directory and a late/partial pair is not bound. */
export async function snapshotGenerationSyncTexSidecar(input: {
  readonly outputPath: string;
  readonly privatePdfPath: string;
  readonly outputIdentity: GenerationOutputIdentity;
  readonly pdfDigest: string;
  readonly previousFingerprint?: SyncTexSidecarFingerprint;
  readonly maxBytes?: number;
}): Promise<GenerationSyncTexSnapshotResult> {
  const extension = extname(input.outputPath);
  const outputStem = extension.toLowerCase() === ".pdf"
    ? input.outputPath.slice(0, -extension.length)
    : input.outputPath;
  const candidates = [`${outputStem}.synctex`, `${outputStem}.synctex.gz`];
  const present = (await Promise.all(candidates.map(async (path) => {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    return info === undefined ? undefined : { path, info };
  }))).filter((value): value is { path: string; info: Stats } => value !== undefined);
  if (present.length === 0) return { status: "missing", reason: "generation-sidecar-not-found" };
  if (present.length !== 1) {
    return { status: "ambiguous", reason: "multiple-sidecar-formats-are-present" };
  }
  const { path: sidecarPath, info: before } = present[0]!;
  const maxBytes = input.maxBytes ?? 64 * 1024 * 1024;
  if (
    !before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > maxBytes
  ) return { status: "stale", reason: "sidecar-is-not-a-bounded-regular-file" };
  if (!await currentOutputMatches(
    input.outputPath,
    input.outputIdentity,
    input.pdfDigest,
  )) return { status: "stale", reason: "pdf-output-no-longer-matches-generation" };

  const handle = await open(sidecarPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (handle === undefined) return { status: "stale", reason: "sidecar-could-not-be-opened-safely" };
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!sameIdentity(
      identityFromStat(sidecarPath, before),
      identityFromStat(sidecarPath, opened),
    )) return { status: "stale", reason: "sidecar-changed-before-private-copy" };
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameIdentity(
      identityFromStat(sidecarPath, before),
      identityFromStat(sidecarPath, after),
    )) return { status: "stale", reason: "sidecar-changed-during-private-copy" };
  } finally {
    await handle.close();
  }
  const afterPath = await lstat(sidecarPath).catch(() => undefined);
  if (
    afterPath === undefined || afterPath.isSymbolicLink() || !afterPath.isFile() ||
    !sameIdentity(identityFromStat(sidecarPath, before), identityFromStat(sidecarPath, afterPath)) ||
    !await currentOutputMatches(input.outputPath, input.outputIdentity, input.pdfDigest)
  ) return { status: "stale", reason: "pdf-sidecar-pair-changed-during-private-copy" };

  const compressed = sidecarPath.endsWith(".gz");
  const fingerprint: SyncTexSidecarFingerprint = {
    digest: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    device: before.dev,
    inode: before.ino,
    modifiedAtMs: before.mtimeMs,
    compressed,
  };
  if (
    input.previousFingerprint !== undefined &&
    input.previousFingerprint.digest === fingerprint.digest &&
    input.previousFingerprint.byteLength === fingerprint.byteLength &&
    input.previousFingerprint.compressed === fingerprint.compressed
  ) return { status: "stale", reason: "sidecar-fingerprint-belongs-to-predecessor-generation" };

  const privateExtension = compressed ? ".synctex.gz" : ".synctex";
  const privatePdfName = basename(input.privatePdfPath);
  const privateStem = privatePdfName.toLowerCase().endsWith(".pdf")
    ? privatePdfName.slice(0, -4)
    : privatePdfName;
  const targetPath = join(dirname(input.privatePdfPath), `${privateStem}${privateExtension}`);
  const temporaryPath = join(dirname(input.privatePdfPath), `.synctex-${randomUUID()}.tmp`);
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
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, 0o600);
    return { status: "ready", snapshot: { snapshotPath: targetPath, fingerprint } };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  } finally {
    stopTracking();
  }
}
