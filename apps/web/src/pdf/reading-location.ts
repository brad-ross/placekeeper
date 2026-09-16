import type {
  ReadingLocationResolutionV1,
  ReadingLocationResolutionRequestV1,
} from '../../../../packages/core/src/review-runtime-protocol.js';
import type { AnchorPage } from './selection-anchor.js';
import { assessPageTextReliability, hasUnsupportedReadingOrder } from './text-reliability.js';
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
  const mapped = page.textRects
    .filter(({ content, rect }) => content.length > 0
      && Number.isFinite(rect.origin.x) && Number.isFinite(rect.origin.y)
      && Number.isFinite(rect.size.width) && rect.size.width > 0
      && Number.isFinite(rect.size.height) && rect.size.height > 0)
    .flatMap(({ content, rect }) => {
      const textOffset = page.extractedText.indexOf(content, textCursor);
      if (textOffset < 0) return [];
      textCursor = textOffset + content.length;
      return [{
        content,
        textOffset,
        rect,
        distance: Math.hypot(
          input.fallback.anchor.x - (rect.origin.x + rect.size.width / 2),
          input.fallback.anchor.y - (rect.origin.y + rect.size.height / 2),
        ),
      }];
    });
  const nearest = mapped.sort((left, right) => left.distance - right.distance)[0];
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
