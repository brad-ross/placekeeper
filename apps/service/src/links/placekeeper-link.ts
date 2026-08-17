import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import {
  decodePlacekeeperReadableViewPathname,
  decodePlacekeeperLink,
  encodePlacekeeperLink,
  placekeeperLinkBase,
  type PlacekeeperLinkLocation,
} from "../../../../packages/core/src/placekeeper-link.js";

export interface ParsedPlacekeeperReadableViewRoute {
  readonly viewId: string;
  readonly pdfPath: string;
  readonly appLinkBase: string;
}

export class PlacekeeperPdfLinkError extends Error {
  readonly code: "MISSING" | "UNREADABLE" | "NOT_PDF";

  constructor(code: PlacekeeperPdfLinkError["code"], filename: string) {
    const detail = code === "MISSING"
      ? "is missing"
      : code === "UNREADABLE"
        ? "is unreadable"
        : "is not a PDF";
    super(`“${filename}” ${detail}`);
    this.name = "PlacekeeperPdfLinkError";
    this.code = code;
  }
}

export interface PreparedPlacekeeperLink {
  readonly pdfPath: string;
  readonly pdfFileUrl: string;
  readonly appLinkBase: string;
  readonly appLink: string;
  readonly location: PlacekeeperLinkLocation;
}

function namedFailure(error: unknown, filename: string): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    throw new PlacekeeperPdfLinkError("MISSING", filename);
  }
  throw new PlacekeeperPdfLinkError("UNREADABLE", filename);
}

async function approveLinkedPdf(path: string): Promise<string> {
  const filename = basename(path) || path;
  if (!isAbsolute(path)) throw new PlacekeeperPdfLinkError("MISSING", filename);

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch (error) {
    return namedFailure(error, filename);
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await stat(canonicalPath);
    if (!info.isFile() || !canonicalPath.toLowerCase().endsWith(".pdf")) {
      throw new PlacekeeperPdfLinkError("NOT_PDF", filename);
    }
    handle = await open(canonicalPath, "r");
    const header = Buffer.alloc(1_024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (header.subarray(0, bytesRead).indexOf(Buffer.from("%PDF-")) < 0) {
      throw new PlacekeeperPdfLinkError("NOT_PDF", filename);
    }
  } catch (error) {
    if (error instanceof PlacekeeperPdfLinkError) throw error;
    return namedFailure(error, filename);
  } finally {
    await handle?.close();
  }
  return canonicalPath;
}

export async function createPlacekeeperLinkForPdf(
  pdfPath: string,
  location: PlacekeeperLinkLocation,
): Promise<PreparedPlacekeeperLink> {
  const canonicalPath = await approveLinkedPdf(pdfPath);
  return {
    pdfPath: canonicalPath,
    pdfFileUrl: pathToFileURL(canonicalPath).href,
    appLinkBase: placekeeperLinkBase(canonicalPath),
    appLink: encodePlacekeeperLink({ path: canonicalPath, location }),
    location,
  };
}

export async function resolvePlacekeeperLink(input: string): Promise<PreparedPlacekeeperLink> {
  const decoded = decodePlacekeeperLink(input);
  return createPlacekeeperLinkForPdf(decoded.path, decoded.location);
}

/** Parses descriptive recovery data only. This must remain free of filesystem access. */
export function parsePlacekeeperReadableViewRoute(
  pathname: string,
): ParsedPlacekeeperReadableViewRoute {
  const decoded = decodePlacekeeperReadableViewPathname(pathname);
  return {
    viewId: decoded.viewId,
    pdfPath: decoded.path,
    appLinkBase: placekeeperLinkBase(decoded.path),
  };
}
