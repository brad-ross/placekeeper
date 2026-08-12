import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { SourceFingerprint } from "../../../../packages/core/src/live-context.js";
import { isContained } from "./file-capabilities.js";

const MAX_SCOPED_SOURCE_BYTES = 16 * 1024 * 1024;

export class UnsafeSourcePathError extends Error {}

function sourceSegments(path: string): readonly string[] {
  return path.replaceAll("\\", "/").split("/");
}

function assertRelativeSourcePath(path: string): void {
  if (
    path.length === 0 || path.includes("\0") || isAbsolute(path) ||
    /^[A-Za-z]:[\\/]/u.test(path) || sourceSegments(path).includes("..")
  ) {
    throw new UnsafeSourcePathError("The source path must be a contained relative path");
  }
}

async function rejectSymlinkAncestors(root: string, target: string): Promise<void> {
  let ancestor = dirname(target);
  while (ancestor !== root) {
    if (!isContained(root, ancestor)) {
      throw new UnsafeSourcePathError("The source path escapes the approved source root");
    }
    const info = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info?.isSymbolicLink() === true) {
      throw new UnsafeSourcePathError("Source paths through symbolic-link ancestors are not allowed");
    }
    ancestor = dirname(ancestor);
  }
}

export async function canonicalSourceRoot(root: string): Promise<string> {
  const canonical = await realpath(root);
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new UnsafeSourcePathError("The approved source root is not a canonical directory");
  }
  return canonical;
}

export async function resolveScopedSourcePath(
  canonicalRoot: string,
  requestedPath: string,
): Promise<{ readonly path: string; readonly relativePath: string }> {
  assertRelativeSourcePath(requestedPath);
  const lexical = resolve(canonicalRoot, requestedPath);
  if (lexical === canonicalRoot || !isContained(canonicalRoot, lexical)) {
    throw new UnsafeSourcePathError("The source path escapes the approved source root");
  }
  await rejectSymlinkAncestors(canonicalRoot, lexical);
  const info = await lstat(lexical);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new UnsafeSourcePathError("The scoped source must be a regular file, not a symbolic link");
  }
  const physical = await realpath(lexical);
  if (physical !== lexical || !isContained(canonicalRoot, physical)) {
    throw new UnsafeSourcePathError("The source path does not resolve canonically inside the approved root");
  }
  return {
    path: physical,
    relativePath: relative(canonicalRoot, physical).split(sep).join("/"),
  };
}

export interface ScopedSourceRead {
  readonly fingerprint: SourceFingerprint;
  readonly text: string;
}

/**
 * Reads a bounded regular file through O_NOFOLLOW and verifies that the same
 * inode was observed before and after the read. This is shared by baseline
 * capture and every reconciliation check; callers must never trust a path or
 * digest supplied by a model.
 */
export async function readScopedSource(
  canonicalRoot: string,
  requestedPath: string,
  maxBytes = MAX_SCOPED_SOURCE_BYTES,
): Promise<ScopedSourceRead> {
  const resolved = await resolveScopedSourcePath(canonicalRoot, requestedPath);
  const handle = await open(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) {
      throw new UnsafeSourcePathError("The scoped source exceeds the reconciliation read limit");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs
    ) {
      throw new UnsafeSourcePathError("The scoped source changed while it was being read");
    }
    return {
      fingerprint: {
        path: resolved.relativePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
      },
      text: bytes.toString("utf8"),
    };
  } finally {
    await handle.close();
  }
}
