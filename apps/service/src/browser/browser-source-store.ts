import { constants, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { verifyPrivatePath } from '../platform/private-storage.js';
import { adoptPrivateFile } from '../platform/private-file-adoption.js';
import { ensurePrivateDirectory } from "../recovery/source-snapshot.js";
import { MAX_CHROME_PDF_BYTES } from "./chrome-pdf-limits.js";

export const CHROME_BROWSER_SOURCE_PROTOCOL_VERSION = 1;
export const CHROME_RUNTIME_SOURCE_PROTOCOL_VERSION = 2;

const SEALED_HANDLE = /^[A-Za-z0-9_-]{32}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

interface ChromeBrowserSourceBaseRequest {
  readonly sourceHandle: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly displayName?: string;
}

export type ChromeBrowserSourceOpenRequest = ChromeBrowserSourceBaseRequest & (
  | { readonly protocolVersion: typeof CHROME_BROWSER_SOURCE_PROTOCOL_VERSION }
  | {
      readonly protocolVersion: typeof CHROME_RUNTIME_SOURCE_PROTOCOL_VERSION;
      /** Native-normalized, opaque source identity; canonical matching also
       * requires the independently verified byte digest. */
      readonly sourceIdentity: string;
    }
);

export interface AdoptedBrowserSource {
  readonly path: string;
  readonly acquisitionId: string;
  readonly leaseId: string;
  readonly disposition: "remote-temporary";
  readonly byteLength: number;
  readonly sha256: string;
  readonly displayName: string;
  readonly sourceIdentity?: string;
}

function safeDisplayName(value: string | undefined): string {
  const candidate = basename((value ?? "Browser PDF.pdf").replace(/\\/gu, "/"))
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, 120);
  const named = candidate === "" ? "Browser PDF.pdf" : candidate;
  return named.toLowerCase().endsWith(".pdf") ? named : `${named.slice(0, 116)}.pdf`;
}

function sameSource(expected: Stats, actual: Stats): boolean {
  return actual.isFile() && actual.dev === expected.dev && actual.ino === expected.ino
    && actual.size === expected.size && actual.mtimeMs === expected.mtimeMs && actual.ctimeMs === expected.ctimeMs;
}
async function hashPath(path: string, expected: Stats): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    if (!sameSource(expected, await handle.stat())) throw new Error('Browser source identity changed');
    const digest = createHash("sha256"); let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: expected.size - 1 })) {
      bytes += chunk.byteLength; digest.update(chunk);
    }
    if (bytes !== expected.size || !sameSource(expected, await handle.stat())) throw new Error('Browser source identity changed');
    return digest.digest("hex");
  } finally { await handle.close(); }
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
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Browser source root must be a secure directory");
    }
    await verifyPrivatePath(canonical, 'directory');
    return new BrowserSourceStore(canonical);
  }

  async adopt(
    request: ChromeBrowserSourceOpenRequest,
    sessionDirectory: string,
  ): Promise<AdoptedBrowserSource> {
    if (
      (request.protocolVersion !== CHROME_BROWSER_SOURCE_PROTOCOL_VERSION &&
        request.protocolVersion !== CHROME_RUNTIME_SOURCE_PROTOCOL_VERSION) ||
      !SEALED_HANDLE.test(request.sourceHandle) ||
      !Number.isSafeInteger(request.byteLength) ||
      request.byteLength <= 0 || request.byteLength > MAX_CHROME_PDF_BYTES ||
      !DIGEST.test(request.sha256)
    ) throw new Error("Invalid browser source claim");

    const sourcePath = join(this.root, `${request.sourceHandle}.pdf`);
    const canonicalParent = await realpath(dirname(sourcePath));
    const metadata = await lstat(sourcePath);
    if (
      canonicalParent !== this.root || metadata.isSymbolicLink() || !metadata.isFile() ||
      metadata.size !== request.byteLength
    ) throw new Error("Browser source claim failed integrity validation");

    await verifyPrivatePath(sourcePath, 'file');
    if (await hashPath(sourcePath, metadata) !== request.sha256) throw new Error('Browser source claim failed integrity validation');
    await ensurePrivateDirectory(sessionDirectory);
    if (!sameSource(metadata, await lstat(sourcePath))) throw new Error('Browser source identity changed');
    const destination = join(sessionDirectory, "source.pdf");
    await adoptPrivateFile(sourcePath, destination);
    return {
      path: destination,
      acquisitionId: randomUUID(),
      leaseId: randomUUID(),
      disposition: "remote-temporary",
      byteLength: request.byteLength,
      sha256: request.sha256,
      displayName: safeDisplayName(request.displayName),
      ...(request.protocolVersion === CHROME_RUNTIME_SOURCE_PROTOCOL_VERSION
        ? { sourceIdentity: request.sourceIdentity }
        : {}),
    };
  }
}

export function isChromeBrowserSourceOpenRequest(
  value: unknown,
): value is ChromeBrowserSourceOpenRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const isRuntime = record.protocolVersion === CHROME_RUNTIME_SOURCE_PROTOCOL_VERSION;
  const keys = ["protocolVersion", "sourceHandle", "byteLength", "sha256",
    ...(record.displayName === undefined ? [] : ["displayName"]),
    ...(isRuntime ? ["sourceIdentity"] : []),
  ];
  if (
    Object.keys(record).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(record, key))
  ) return false;
  return (record.protocolVersion === CHROME_BROWSER_SOURCE_PROTOCOL_VERSION || isRuntime) &&
    typeof record.sourceHandle === "string" && SEALED_HANDLE.test(record.sourceHandle) &&
    Number.isSafeInteger(record.byteLength) && (record.byteLength as number) > 0 &&
    (record.byteLength as number) <= MAX_CHROME_PDF_BYTES &&
    typeof record.sha256 === "string" && DIGEST.test(record.sha256) &&
    (!isRuntime || (typeof record.sourceIdentity === "string" && DIGEST.test(record.sourceIdentity))) &&
    (record.displayName === undefined ||
      (typeof record.displayName === "string" && record.displayName.length > 0 &&
        record.displayName.length <= 120));
}
