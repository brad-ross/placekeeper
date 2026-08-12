import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export class FileCapabilityError extends Error {
  readonly code:
    | "INVALID_PATH"
    | "OUTSIDE_ROOT"
    | "NOT_PDF"
    | "TARGET_CHANGED"
    | "SOURCE_CHANGED";

  constructor(code: FileCapabilityError["code"], message: string) {
    super(message);
    this.name = "FileCapabilityError";
    this.code = code;
  }
}

interface ApprovedFile {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

interface ApprovedRoot extends ApprovedFile {}

export interface DestinationCapability {
  readonly id: string;
  readonly parentPath: string;
  readonly filename: string;
  readonly parentDevice: number;
  readonly parentInode: number;
  readonly existingTarget?: ApprovedFile;
  readonly expectedDigest?: string;
}

export function validatePdfFilename(filename: string): string {
  const normalized = filename.normalize("NFC");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(normalized) ||
    !normalized.toLowerCase().endsWith(".pdf")
  ) {
    throw new FileCapabilityError("INVALID_PATH", "Use one PDF filename without folders");
  }
  return normalized;
}

function rejectPathSyntax(value: string): void {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    /^file:/iu.test(value) ||
    /^https?:/iu.test(value)
  ) {
    throw new FileCapabilityError("INVALID_PATH", "A local filesystem path is required");
  }
}

function isContained(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

async function hashFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export class FileCapabilityRegistry {
  readonly #files = new Map<string, ApprovedFile>();
  readonly #roots = new Map<string, ApprovedRoot>();
  readonly #destinations = new Map<string, DestinationCapability>();

  async approvePdf(path: string): Promise<{ id: string; canonicalPath: string }> {
    rejectPathSyntax(path);
    const canonicalPath = await realpath(path);
    const info = await stat(canonicalPath);
    if (!info.isFile() || !canonicalPath.toLowerCase().endsWith(".pdf")) {
      throw new FileCapabilityError("NOT_PDF", "The selected file must be a regular PDF");
    }
    const id = randomUUID();
    this.#files.set(id, {
      path: canonicalPath,
      device: info.dev,
      inode: info.ino,
    });
    return { id, canonicalPath };
  }

  async approveRoot(path: string): Promise<{ id: string; canonicalPath: string }> {
    rejectPathSyntax(path);
    const canonicalPath = await realpath(path);
    const info = await stat(canonicalPath);
    if (!info.isDirectory()) {
      throw new FileCapabilityError("INVALID_PATH", "The source root must be a directory");
    }
    const id = randomUUID();
    this.#roots.set(id, {
      path: canonicalPath,
      device: info.dev,
      inode: info.ino,
    });
    return { id, canonicalPath };
  }

  getFilePath(id: string): string | undefined {
    return this.#files.get(id)?.path;
  }

  getRootPath(id: string): string | undefined {
    return this.#roots.get(id)?.path;
  }

  async resolveRootEntry(rootId: string, requestedPath: string): Promise<string> {
    const root = this.#roots.get(rootId);
    if (root === undefined) {
      throw new FileCapabilityError("INVALID_PATH", "Unknown root capability");
    }
    const currentRootPath = await realpath(root.path);
    const currentRootInfo = await stat(currentRootPath);
    if (
      currentRootPath !== root.path ||
      currentRootInfo.dev !== root.device ||
      currentRootInfo.ino !== root.inode
    ) {
      throw new FileCapabilityError("TARGET_CHANGED", "Approved root changed");
    }
    rejectPathSyntax(requestedPath);
    if (isAbsolute(requestedPath)) {
      throw new FileCapabilityError("INVALID_PATH", "Root entries must be relative");
    }
    const lexicalPath = resolve(root.path, requestedPath);
    if (!isContained(root.path, lexicalPath)) {
      throw new FileCapabilityError("OUTSIDE_ROOT", "Path escapes the approved root");
    }
    const canonicalPath = await realpath(lexicalPath);
    if (!isContained(root.path, canonicalPath)) {
      throw new FileCapabilityError("OUTSIDE_ROOT", "Symlink escapes the approved root");
    }
    return canonicalPath;
  }

  async preauthorizeDestination(path: string): Promise<DestinationCapability> {
    rejectPathSyntax(path);
    if (!isAbsolute(path)) {
      throw new FileCapabilityError("INVALID_PATH", "Destination must be explicit and absolute");
    }
    const parentPath = await realpath(dirname(path));
    const parentInfo = await stat(parentPath);
    if (!parentInfo.isDirectory()) {
      throw new FileCapabilityError("INVALID_PATH", "Destination parent is not a directory");
    }
    let existingTarget: ApprovedFile | undefined;
    try {
      const targetPath = await realpath(path);
      const targetInfo = await stat(targetPath);
      existingTarget = {
        path: targetPath,
        device: targetInfo.dev,
        inode: targetInfo.ino,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const filename = validatePdfFilename(basename(path));
    const capability: DestinationCapability = {
      id: randomUUID(),
      parentPath,
      filename,
      parentDevice: parentInfo.dev,
      parentInode: parentInfo.ino,
      ...(existingTarget === undefined ? {} : { existingTarget }),
    };
    this.#destinations.set(capability.id, capability);
    return capability;
  }

  async validateDestination(id: string): Promise<string> {
    const capability = this.#destinations.get(id);
    if (capability === undefined) {
      throw new FileCapabilityError("INVALID_PATH", "Unknown destination capability");
    }
    const parentPath = await realpath(capability.parentPath);
    const parentInfo = await stat(parentPath);
    if (
      parentPath !== capability.parentPath ||
      parentInfo.dev !== capability.parentDevice ||
      parentInfo.ino !== capability.parentInode
    ) {
      throw new FileCapabilityError("TARGET_CHANGED", "Destination parent changed");
    }
    const target = resolve(parentPath, capability.filename);
    if (!isContained(parentPath, target)) {
      throw new FileCapabilityError("OUTSIDE_ROOT", "Destination escapes its approved parent");
    }
    if (capability.existingTarget !== undefined) {
      const currentPath = await realpath(target);
      const currentInfo = await stat(currentPath);
      if (
        currentPath !== capability.existingTarget.path ||
        currentInfo.dev !== capability.existingTarget.device ||
        currentInfo.ino !== capability.existingTarget.inode ||
        (capability.expectedDigest !== undefined &&
          (await hashFile(currentPath)) !== capability.expectedDigest)
      ) {
        throw new FileCapabilityError("TARGET_CHANGED", "Destination changed after approval");
      }
    } else {
      try {
        await lstat(target);
        throw new FileCapabilityError(
          "TARGET_CHANGED",
          "Destination appeared after approval",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return target;
  }

  async refreshDestination(id: string, expectedDigest: string): Promise<string> {
    const capability = this.#destinations.get(id);
    if (capability === undefined) {
      throw new FileCapabilityError("INVALID_PATH", "Unknown destination capability");
    }
    const target = resolve(capability.parentPath, capability.filename);
    const canonicalPath = await realpath(target);
    const info = await stat(canonicalPath);
    if (!info.isFile() || (await hashFile(canonicalPath)) !== expectedDigest) {
      throw new FileCapabilityError("TARGET_CHANGED", "Saved target could not be re-approved");
    }
    this.#destinations.set(id, {
      ...capability,
      existingTarget: { path: canonicalPath, device: info.dev, inode: info.ino },
      expectedDigest,
    });
    return canonicalPath;
  }

  revokeDestination(id: string): void {
    this.#destinations.delete(id);
  }

  async validateOriginalForReplacement(
    fileId: string,
    expectedDigest: string,
  ): Promise<string> {
    const approved = this.#files.get(fileId);
    if (approved === undefined) {
      throw new FileCapabilityError("INVALID_PATH", "Unknown file capability");
    }
    const canonicalPath = await realpath(approved.path);
    const info = await stat(canonicalPath);
    if (
      canonicalPath !== approved.path ||
      info.dev !== approved.device ||
      info.ino !== approved.inode ||
      (await hashFile(canonicalPath)) !== expectedDigest
    ) {
      throw new FileCapabilityError("SOURCE_CHANGED", "Original changed since review opened");
    }
    return canonicalPath;
  }

  async refreshApprovedPdf(fileId: string, expectedDigest: string): Promise<string> {
    const approved = this.#files.get(fileId);
    if (approved === undefined) {
      throw new FileCapabilityError("INVALID_PATH", "Unknown file capability");
    }
    const canonicalPath = await realpath(approved.path);
    const info = await stat(canonicalPath);
    if (
      canonicalPath !== approved.path ||
      !info.isFile() ||
      (await hashFile(canonicalPath)) !== expectedDigest
    ) {
      throw new FileCapabilityError(
        "SOURCE_CHANGED",
        "The app-authored replacement could not be re-approved",
      );
    }
    this.#files.set(fileId, {
      path: canonicalPath,
      device: info.dev,
      inode: info.ino,
    });
    return canonicalPath;
  }

  async rebindApprovedPdf(fileId: string, path: string, expectedDigest: string): Promise<string> {
    if (!this.#files.has(fileId)) {
      throw new FileCapabilityError("INVALID_PATH", "Unknown file capability");
    }
    const canonicalPath = await realpath(path);
    const info = await stat(canonicalPath);
    if (
      !info.isFile() ||
      !canonicalPath.toLowerCase().endsWith(".pdf") ||
      (await hashFile(canonicalPath)) !== expectedDigest
    ) {
      throw new FileCapabilityError("TARGET_CHANGED", "Located PDF does not match the saved target");
    }
    this.#files.set(fileId, { path: canonicalPath, device: info.dev, inode: info.ino });
    return canonicalPath;
  }

  revokeFile(id: string): void {
    this.#files.delete(id);
  }

  revokeRoot(id: string): void {
    this.#roots.delete(id);
  }
}

export { hashFile, isContained };
