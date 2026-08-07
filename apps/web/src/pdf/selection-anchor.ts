import { Rotation, type Rect, type Size } from '@embedpdf/models';

import {
  assessPageTextReliability,
  assessSelectionReliability,
  SELECTION_UNAVAILABLE_MESSAGE,
  type PageText,
  type ReliabilityDiagnostic,
} from './text-reliability.js';

export interface CropBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface AnchorPage extends PageText {
  pageIndex: number;
  size: Size;
  cropBox: CropBox;
  rotation: Rotation;
}

export interface FormattedSelection {
  pageIndex: number;
  segmentRects: readonly Rect[];
  coordinateRotation: Rotation;
  /** Scale applied to segmentRects by the viewer. Omit when they are already in page units. */
  coordinateScale?: number;
}

export interface PdfSpaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectionAnchor {
  pageIndex: number;
  quote: string;
  prefix: string;
  suffix: string;
  rect: PdfSpaceRect;
  segmentRects: PdfSpaceRect[];
  reliable: true;
}

export interface CaretAnchor {
  pageIndex: number;
  position: PdfSpaceRect;
  leftContext: string;
  rightContext: string;
  reliable: true;
}

export type SelectionAnchorResult =
  | { ok: true; anchor: SelectionAnchor }
  | { ok: false; userMessage: string; diagnostic: ReliabilityDiagnostic };

export interface CreateSelectionAnchorInput {
  page: AnchorPage;
  quote: string;
  /** Exact engine character/glyph offset when available; disambiguates repeated text. */
  quoteStart?: number;
  glyphCount: number;
  formattedSelections: readonly FormattedSelection[];
  contextCharacters?: number;
}

function toNaturalRect(page: AnchorPage, selection: FormattedSelection, rect: Rect): Rect {
  const scale = selection.coordinateScale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0) return rect;
  const x = rect.origin.x / scale;
  const y = rect.origin.y / scale;
  const width = rect.size.width / scale;
  const height = rect.size.height / scale;

  switch (selection.coordinateRotation) {
    case Rotation.Degree90:
      return {
        origin: { x: y, y: page.size.height - x - width },
        size: { width: height, height: width },
      };
    case Rotation.Degree180:
      return {
        origin: {
          x: page.size.width - x - width,
          y: page.size.height - y - height,
        },
        size: { width, height },
      };
    case Rotation.Degree270:
      return {
        origin: { x: page.size.width - y - height, y: x },
        size: { width: height, height: width },
      };
    default:
      return { origin: { x, y }, size: { width, height } };
  }
}

function toPdfSpace(page: AnchorPage, rect: Rect): PdfSpaceRect {
  return {
    x: rect.origin.x + page.cropBox.left,
    y: rect.origin.y + page.cropBox.top,
    width: rect.size.width,
    height: rect.size.height,
  };
}

function union(rects: readonly PdfSpaceRect[]): PdfSpaceRect {
  const first = rects[0]!;
  const left = Math.min(...rects.map(({ x }) => x));
  const top = Math.min(...rects.map(({ y }) => y));
  const right = Math.max(...rects.map(({ x, width }) => x + width));
  const bottom = Math.max(...rects.map(({ y, height }) => y + height));
  return {
    x: left,
    y: top,
    width: right - left || first.width,
    height: bottom - top || first.height,
  };
}

function isInPage(page: AnchorPage, rect: Rect): boolean {
  const epsilon = 0.001;
  return (
    rect.origin.x >= -epsilon &&
    rect.origin.y >= -epsilon &&
    rect.origin.x + rect.size.width <= page.size.width + epsilon &&
    rect.origin.y + rect.size.height <= page.size.height + epsilon
  );
}

export function createSelectionAnchor(input: CreateSelectionAnchorInput): SelectionAnchorResult {
  if (
    input.formattedSelections.some(
      ({ coordinateScale = 1 }) =>
        !Number.isFinite(coordinateScale) || coordinateScale <= 0,
    )
  ) {
    return {
      ok: false,
      userMessage: SELECTION_UNAVAILABLE_MESSAGE,
      diagnostic: 'selection-geometry-invalid',
    };
  }
  const naturalRects = input.formattedSelections.flatMap((selection) =>
    selection.segmentRects.map((rect) => toNaturalRect(input.page, selection, rect)),
  );
  const pageIndexes = input.formattedSelections.map(({ pageIndex }) => pageIndex);
  const reliability = assessSelectionReliability({
    page: input.page,
    pageIndexes,
    quote: input.quote,
    ...(input.quoteStart === undefined ? {} : { quoteStart: input.quoteStart }),
    glyphCount: input.glyphCount,
    segmentRects: naturalRects,
  });

  if (!reliability.reliable) {
    return {
      ok: false,
      userMessage: SELECTION_UNAVAILABLE_MESSAGE,
      diagnostic: reliability.diagnostic,
    };
  }

  if (naturalRects.some((rect) => !isInPage(input.page, rect))) {
    return {
      ok: false,
      userMessage: SELECTION_UNAVAILABLE_MESSAGE,
      diagnostic: 'selection-geometry-out-of-bounds',
    };
  }

  const quoteIndex = input.quoteStart ?? input.page.extractedText.indexOf(input.quote);
  const contextCharacters = Math.max(0, input.contextCharacters ?? 48);
  const segmentRects = naturalRects.map((rect) => toPdfSpace(input.page, rect));
  return {
    ok: true,
    anchor: {
      pageIndex: input.page.pageIndex,
      quote: input.quote,
      prefix: input.page.extractedText.slice(Math.max(0, quoteIndex - contextCharacters), quoteIndex),
      suffix: input.page.extractedText.slice(
        quoteIndex + input.quote.length,
        quoteIndex + input.quote.length + contextCharacters,
      ),
      rect: union(segmentRects),
      segmentRects,
      reliable: true,
    },
  };
}

export interface CreateCaretAnchorInput {
  page: AnchorPage;
  textOffset: number;
  position: Rect;
  coordinateRotation?: Rotation;
  coordinateScale?: number;
  contextCharacters?: number;
}

export function createCaretAnchor(
  input: CreateCaretAnchorInput,
): { ok: true; anchor: CaretAnchor } | SelectionAnchorResult {
  const pageReliability = assessPageTextReliability(input.page);
  if (!pageReliability.reliable) {
    return {
      ok: false,
      userMessage: SELECTION_UNAVAILABLE_MESSAGE,
      diagnostic: pageReliability.diagnostic,
    };
  }
  if (
    input.coordinateScale !== undefined &&
    (!Number.isFinite(input.coordinateScale) || input.coordinateScale <= 0)
  ) {
    return {
      ok: false,
      userMessage: SELECTION_UNAVAILABLE_MESSAGE,
      diagnostic: 'selection-geometry-invalid',
    };
  }
  if (!Number.isInteger(input.textOffset) || input.textOffset < 0 || input.textOffset > input.page.extractedText.length) {
    return {
      ok: false,
      userMessage: SELECTION_UNAVAILABLE_MESSAGE,
      diagnostic: 'selection-text-geometry-mismatch',
    };
  }
  const natural = toNaturalRect(
    input.page,
    {
      pageIndex: input.page.pageIndex,
      segmentRects: [input.position],
      coordinateRotation: input.coordinateRotation ?? input.page.rotation,
      ...(input.coordinateScale === undefined ? {} : { coordinateScale: input.coordinateScale }),
    },
    input.position,
  );
  if (
    !Number.isFinite(natural.origin.x) ||
    !Number.isFinite(natural.origin.y) ||
    natural.size.width <= 0 ||
    natural.size.height <= 0 ||
    !isInPage(input.page, natural)
  ) {
    return {
      ok: false,
      userMessage: SELECTION_UNAVAILABLE_MESSAGE,
      diagnostic: 'selection-geometry-out-of-bounds',
    };
  }
  const contextCharacters = Math.max(0, input.contextCharacters ?? 48);
  return {
    ok: true,
    anchor: {
      pageIndex: input.page.pageIndex,
      position: toPdfSpace(input.page, natural),
      leftContext: input.page.extractedText.slice(
        Math.max(0, input.textOffset - contextCharacters),
        input.textOffset,
      ),
      rightContext: input.page.extractedText.slice(
        input.textOffset,
        input.textOffset + contextCharacters,
      ),
      reliable: true,
    },
  };
}
