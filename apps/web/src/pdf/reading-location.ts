import type {
  ReadingLocationResolutionV1,
  ReadingLocationResolutionRequestV1,
} from '../../../../packages/core/src/review-runtime-protocol.js';
import type { AnchorPage } from './selection-anchor.js';
import {
  assessPageTextReliability,
  hasUnsupportedReadingOrder,
  isValidTextRect,
} from './text-reliability.js';
import type { PdfViewerLocation } from './viewer-navigation.js';

export interface CapturedReadingLocation {
  readonly generation: number;
  readonly viewportIdentity: number;
  readonly fallback: PdfViewerLocation;
  readonly anchor: ReadingLocationResolutionRequestV1['anchor'] | null;
  readonly offset: { readonly x: number; readonly y: number };
}

export function readingCaptureIsCurrent(
  captured: CapturedReadingLocation,
  generation: number,
  viewportIdentity: number,
): boolean {
  return captured.generation === generation && captured.viewportIdentity === viewportIdentity;
}

export function fallbackReadingLocation(input: {
  readonly generation: number;
  readonly viewportIdentity: number;
  readonly fallback: PdfViewerLocation;
}): CapturedReadingLocation {
  return { ...input, anchor: null, offset: { x: 0, y: 0 } };
}

export async function captureReadingLocation(input: {
  readonly generation: number;
  readonly viewportIdentity: number;
  readonly fallback: PdfViewerLocation;
  readonly page: AnchorPage | Promise<AnchorPage>;
}): Promise<CapturedReadingLocation> {
  let page: AnchorPage;
  try {
    page = await input.page;
  } catch {
    return fallbackReadingLocation(input);
  }
  let textCursor = 0;
  let nearest: {
    readonly content: string;
    readonly textOffset: number;
    readonly rect: AnchorPage['textRects'][number]['rect'];
    readonly distance: number;
  } | undefined;
  for (const { content, rect } of page.textRects) {
    if (content.length === 0 || !isValidTextRect(rect)) continue;
    const textOffset = page.extractedText.indexOf(content, textCursor);
    if (textOffset < 0) continue;
    textCursor = textOffset + content.length;
    const distance = Math.hypot(
      input.fallback.anchor.x - (rect.origin.x + rect.size.width / 2),
      input.fallback.anchor.y - (rect.origin.y + rect.size.height / 2),
    );
    if (nearest === undefined || distance < nearest.distance) {
      nearest = { content, textOffset, rect, distance };
    }
  }
  if (nearest === undefined) {
    return fallbackReadingLocation(input);
  }
  const pageReliability = assessPageTextReliability(page);
  if (!pageReliability.reliable || hasUnsupportedReadingOrder(nearest.content)) {
    return fallbackReadingLocation(input);
  }
  const rect = {
    x: nearest.rect.origin.x,
    y: nearest.rect.origin.y,
    width: Math.min(1, nearest.rect.size.width),
    height: nearest.rect.size.height,
  };
  const leftContext = page.extractedText.slice(Math.max(0, nearest.textOffset - 64), nearest.textOffset);
  const rightContext = page.extractedText.slice(nearest.textOffset, nearest.textOffset + 64);
  return {
    generation: input.generation,
    viewportIdentity: input.viewportIdentity,
    fallback: input.fallback,
    anchor: {
      kind: 'caret',
      pageIndex: page.pageIndex,
      leftContext,
      rightContext,
      rect,
    },
    offset: {
      x: input.fallback.anchor.x - rect.x,
      y: input.fallback.anchor.y - rect.y,
    },
  };
}

export function readingLocationRequest(
  captured: CapturedReadingLocation,
): ReadingLocationResolutionRequestV1 | null {
  return captured.anchor === null
    ? null
    : { generation: captured.generation, anchor: captured.anchor };
}

export function resolvedReadingLocation(
  captured: CapturedReadingLocation,
  resolution: ReadingLocationResolutionV1,
): PdfViewerLocation {
  if (resolution.status !== 'resolved') {
    const pageIndex = resolution.status === 'fallback'
      ? Math.min(captured.fallback.pageIndex, resolution.pageCount - 1)
      : captured.fallback.pageIndex;
    return { ...captured.fallback, pageIndex };
  }
  return {
    ...captured.fallback,
    pageIndex: resolution.pageIndex,
    anchor: {
      x: resolution.rect.x + captured.offset.x,
      y: resolution.rect.y + captured.offset.y,
    },
  };
}
