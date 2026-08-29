import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import {
  decodePlacekeeperLink,
  decodePlacekeeperReadableViewPathname,
  placekeeperLinkBase,
  type PlacekeeperLinkLocation,
} from "../../../../packages/core/src/placekeeper-link.js";
import type {
  LaunchSurface,
  OpenReviewResult,
  RecoveryDecision,
  RecoveryOfferIdentity,
  SessionBroker,
} from "../sessions/session-broker.js";

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
  readonly location: PlacekeeperLinkLocation;
}

export interface OpenPlacekeeperLinkRequest {
  readonly link: string;
  readonly confirmed?: boolean;
  readonly recovery?: RecoveryDecision;
  readonly recoveryOffer?: RecoveryOfferIdentity;
  readonly recoveryOperationId?: string;
  readonly surface: LaunchSurface;
}

export type OpenPlacekeeperLinkResult = OpenReviewResult | {
  readonly kind: "confirmation-required";
  readonly path: string;
};

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
    if (!canonicalPath.toLowerCase().endsWith(".pdf")) {
      throw new PlacekeeperPdfLinkError("NOT_PDF", filename);
    }
    handle = await open(canonicalPath, "r");
    if (!(await handle.stat()).isFile()) {
      throw new PlacekeeperPdfLinkError("NOT_PDF", filename);
    }
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
    location,
  };
}

/** Applies the confirmation and file checks shared by every trusted link launcher. */
export async function openPlacekeeperLink(
  broker: SessionBroker,
  request: OpenPlacekeeperLinkRequest,
): Promise<OpenPlacekeeperLinkResult> {
  const decoded = decodePlacekeeperLink(request.link);
  // Keep this check synchronous with the first linked file operation. If an
  // ownership exemption vanished, no PDF is resolved, opened, or substituted.
  if (request.confirmed !== true && !broker.activeReviewOwnsPath(decoded.path)) {
    return { kind: "confirmation-required", path: decoded.path };
  }
  const prepared = await createPlacekeeperLinkForPdf(
    await broker.resolveReadableSourcePath(decoded.path),
    decoded.location,
  );
  return broker.openReview({
    pdfPath: prepared.pdfPath,
    ...(request.recovery === undefined ? {} : { recoveryDecision: request.recovery }),
    ...(request.recoveryOffer === undefined ? {} : { recoveryOffer: request.recoveryOffer }),
    ...(request.recoveryOperationId === undefined
      ? {}
      : { recoveryOperationId: request.recoveryOperationId }),
    surface: request.surface,
    requestedLocation: prepared.location,
  });
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
