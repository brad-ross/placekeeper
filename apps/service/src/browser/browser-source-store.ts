import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { ensurePrivateDirectory } from "../recovery/source-snapshot.js";

export const CHROME_BROWSER_SOURCE_PROTOCOL_VERSION = 1;

const SEALED_HANDLE = /^[A-Za-z0-9_-]{32}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_BROWSER_SOURCE_BYTES = 256 * 1024 * 1024;

export interface ChromeBrowserSourceOpenRequest {
  readonly protocolVersion: typeof CHROME_BROWSER_SOURCE_PROTOCOL_VERSION;
  readonly sourceHandle: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly displayName?: string;
}

export interface AdoptedBrowserSource {
  readonly path: string;
  readonly acquisitionId: string;
  readonly leaseId: string;
  readonly disposition: "remote-temporary";
  readonly byteLength: number;
  readonly sha256: string;
  readonly displayName: string;
}

function safeDisplayName(value: string | undefined): string {
  const candidate = basename((value ?? "Browser PDF.pdf").replace(/\\/gu, "/"))
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, 120);
  const named = candidate === "" ? "Browser PDF.pdf" : candidate;
  return named.toLowerCase().endsWith(".pdf") ? named : `${named.slice(0, 116)}.pdf`;
}

async function hashPath(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Resolves opaque native-host handles only below one fixed private root. */
export class BrowserSourceStore {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(root: string): Promise<BrowserSourceStore> {
    await ensurePrivateDirectory(resolve(root));
    const metadata = await lstat(resolve(root));
    const canonical = await realpath(resolve(root));
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw new Error("Browser source root must be a secure directory");
    }
    return new BrowserSourceStore(canonical);
  }

  async adopt(
    request: ChromeBrowserSourceOpenRequest,
    sessionDirectory: string,
  ): Promise<AdoptedBrowserSource> {
    if (
      request.protocolVersion !== CHROME_BROWSER_SOURCE_PROTOCOL_VERSION ||
      !SEALED_HANDLE.test(request.sourceHandle) ||
      !Number.isSafeInteger(request.byteLength) ||
      request.byteLength <= 0 || request.byteLength > MAX_BROWSER_SOURCE_BYTES ||
      !DIGEST.test(request.sha256)
    ) throw new Error("Invalid browser source claim");

    const sourcePath = join(this.root, `${request.sourceHandle}.pdf`);
    const canonicalParent = await realpath(dirname(sourcePath));
    const metadata = await lstat(sourcePath);
    if (
      canonicalParent !== this.root || metadata.isSymbolicLink() || !metadata.isFile() ||
      metadata.size !== request.byteLength || (metadata.mode & 0o077) !== 0 ||
      await hashPath(sourcePath) !== request.sha256
    ) throw new Error("Browser source claim failed integrity validation");

    await ensurePrivateDirectory(sessionDirectory);
    const destination = join(sessionDirectory, "source.pdf");
    try {
      await rename(sourcePath, destination);
      await chmod(destination, 0o600);
      await syncDirectory(this.root);
      await syncDirectory(sessionDirectory);
    } catch (error) {
      await rm(destination, { force: true }).catch(() => undefined);
      throw error;
    }
    return {
      path: destination,
      acquisitionId: randomUUID(),
      leaseId: randomUUID(),
      disposition: "remote-temporary",
      byteLength: request.byteLength,
      sha256: request.sha256,
      displayName: safeDisplayName(request.displayName),
    };
  }
}

export function isChromeBrowserSourceOpenRequest(
  value: unknown,
): value is ChromeBrowserSourceOpenRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = record.displayName === undefined
    ? ["protocolVersion", "sourceHandle", "byteLength", "sha256"]
    : ["protocolVersion", "sourceHandle", "byteLength", "sha256", "displayName"];
  if (
    Object.keys(record).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(record, key))
  ) return false;
  return record.protocolVersion === CHROME_BROWSER_SOURCE_PROTOCOL_VERSION &&
    typeof record.sourceHandle === "string" && SEALED_HANDLE.test(record.sourceHandle) &&
    Number.isSafeInteger(record.byteLength) && (record.byteLength as number) > 0 &&
    (record.byteLength as number) <= MAX_BROWSER_SOURCE_BYTES &&
    typeof record.sha256 === "string" && DIGEST.test(record.sha256) &&
    (record.displayName === undefined ||
      (typeof record.displayName === "string" && record.displayName.length > 0 &&
        record.displayName.length <= 120));
}
