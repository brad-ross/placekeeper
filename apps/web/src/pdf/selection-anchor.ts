import { Rotation, type Position, type Rect, type Size } from '@embedpdf/models';
import type {
  ReviewSelectionAnchorV1,
  ReviewSelectionPageEvidenceV1,
} from '../../../../packages/core/src/review-model.js';
import { normalizeReviewSelectionAnchor } from '../../../../packages/core/src/review-model.js';

import {
  assessPageTextReliability,
  assessSelectionReliability,
  hasUnsupportedReadingOrder,
  isValidTextRect,
  SELECTION_UNAVAILABLE_MESSAGE,
  type PageText,
  type ReliabilityDiagnostic,
} from './text-reliability.js';

export interface AnchorPage extends PageText {
  pageIndex: number;
  size: Size;
  rotation: Rotation;
  /** Exact PDFium character geometry with explicit extracted-text offsets. */
  glyphs?: readonly AnchorGlyph[];
}

export interface AnchorGlyph {
  readonly textOffset: number;
  readonly rect: Rect;
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

export interface SelectionAnchor extends ReviewSelectionAnchorV1 {
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

export interface CreateSelectionAnchorSpanInput {
  readonly pages: readonly CreateSelectionAnchorInput[];
  readonly separator?: string;
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

function toPageSpace(rect: Rect): PdfSpaceRect {
  return {
    x: rect.origin.x,
    y: rect.origin.y,
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
  const segmentRects = naturalRects.map(toPageSpace);
  const prefix = input.page.extractedText.slice(Math.max(0, quoteIndex - contextCharacters), quoteIndex);
  const suffix = input.page.extractedText.slice(
    quoteIndex + input.quote.length,
    quoteIndex + input.quote.length + contextCharacters,
  );
  const rect = union(segmentRects);
  const pageEvidence: ReviewSelectionPageEvidenceV1 = {
    pageIndex: input.page.pageIndex,
    quote: input.quote,
    prefix,
    suffix,
    rect,
    segmentRects,
  };
  return {
    ok: true,
    anchor: {
      pageIndex: input.page.pageIndex,
      quote: input.quote,
      prefix,
      suffix,
      rect,
      segmentRects,
      pages: [pageEvidence],
      pageBoundaries: [],
      reliable: true,
    },
  };
}

/** Normalize viewer drag direction into one document-ordered logical anchor. */
export function createSelectionAnchorSpan(
  input: CreateSelectionAnchorSpanInput,
): SelectionAnchorResult {
  const pages = [...input.pages].sort((left, right) => left.page.pageIndex - right.page.pageIndex);
  if (
    pages.length === 0 ||
    pages.some((page, index) => index > 0 && page.page.pageIndex !== pages[index - 1]!.page.pageIndex + 1)
  ) {
    return {
      ok: false,
      userMessage: SELECTION_UNAVAILABLE_MESSAGE,
      diagnostic: 'selection-crosses-pages',
    };
  }
  const anchors: SelectionAnchor[] = [];
  for (const page of pages) {
    const result = createSelectionAnchor(page);
    if (!result.ok) return result;
    anchors.push(result.anchor);
  }
  const separator = input.separator ?? '\n';
  const pageEntries = anchors.map((anchor) => normalizeReviewSelectionAnchor(anchor).pages[0]!);
  const first = pageEntries[0]!;
  const last = pageEntries.at(-1)!;
  return {
    ok: true,
    anchor: {
      pageIndex: first.pageIndex,
      quote: pageEntries.map(({ quote }) => quote).join(separator),
      prefix: first.prefix,
      suffix: last.suffix,
      rect: first.rect,
      segmentRects: [...first.segmentRects],
      pages: pageEntries,
      pageBoundaries: pageEntries.slice(0, -1).map(({ pageIndex }) => ({
        afterPageIndex: pageIndex,
        separator,
      })),
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

export type CaretAnchorResult =
  | { ok: true; anchor: CaretAnchor }
  | { ok: false; userMessage: string; diagnostic: ReliabilityDiagnostic };

export function createCaretAnchor(
  input: CreateCaretAnchorInput,
): CaretAnchorResult {
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
      position: toPageSpace(natural),
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

interface MappedTextRect {
  readonly content: string;
  readonly rect: Rect;
  readonly start: number;
  readonly end: number;
}

// Older PDFium bindings can expose a stale trailing control unit that page text omits.
const PDFIUM_TRAILING_TEXT_CONTROL = /[\u0000-\u001f\u007f-\u009f]$/u;

export interface CreateCaretAnchorAtPointInput {
  readonly page: AnchorPage;
  /** Pointer in the declared presentation coordinate space. */
  readonly point: Position;
  readonly coordinateRotation?: Rotation;
  readonly coordinateScale?: number;
  readonly contextCharacters?: number;
}

export type CaretAnchorDiagnosticResult = CaretAnchorResult;

function caretFailure(diagnostic: ReliabilityDiagnostic): CaretAnchorDiagnosticResult {
  return { ok: false, userMessage: SELECTION_UNAVAILABLE_MESSAGE, diagnostic };
}

export function restorePagePoint(size: Size, point: Position, rotation: Rotation, scale: number): Position {
  const x = point.x / scale;
  const y = point.y / scale;
  switch (rotation) {
    case Rotation.Degree90:
      return { x: y, y: size.height - x };
    case Rotation.Degree180:
      return { x: size.width - x, y: size.height - y };
    case Rotation.Degree270:
      return { x: size.width - y, y: x };
    default:
      return { x, y };
  }
}

function textOccurrences(text: string, content: string, from: number): number[] {
  const offsets: number[] = [];
  let cursor = from;
  while (cursor <= text.length - content.length) {
    const next = text.indexOf(content, cursor);
    if (next < 0) break;
    offsets.push(next);
    cursor = next + Math.max(content.length, 1);
  }
  return offsets;
}

function alignTextRects(page: AnchorPage): readonly MappedTextRect[] | null {
  const rects = page.textRects.filter(({ content }) => content.length > 0);
  const occurrenceCache = new Map<string, Map<number, readonly number[]>>();
  const occurrences = (content: string, offset: number) => {
    let byOffset = occurrenceCache.get(content);
    if (!byOffset) {
      byOffset = new Map();
      occurrenceCache.set(content, byOffset);
    }
    const cached = byOffset.get(offset);
    if (cached) return cached;
    const result = textOccurrences(page.extractedText, content, offset);
    byOffset.set(offset, result);
    return result;
  };
  const solutionCache = new Map<string, readonly MappedTextRect[][]>();
  const solve = (index: number, offset: number): readonly MappedTextRect[][] => {
    if (index === rects.length) return [[]];
    const cacheKey = `${index}:${offset}`;
    const cached = solutionCache.get(cacheKey);
    if (cached) return cached;
    const current = rects[index]!;
    let content = current.content;
    let starts = occurrences(content, offset);
    while (
      starts.length === 0
      && content.length > 1
      && PDFIUM_TRAILING_TEXT_CONTROL.test(content)
    ) {
      content = content.slice(0, -1);
      starts = occurrences(content, offset);
    }
    const solutions: MappedTextRect[][] = [];
    for (const start of starts) {
      const mapped = {
        content,
        rect: current.rect,
        start,
        end: start + content.length,
      };
      for (const suffix of solve(index + 1, mapped.end)) {
        solutions.push([mapped, ...suffix]);
        if (solutions.length > 1) break;
      }
      if (solutions.length > 1) break;
    }
    solutionCache.set(cacheKey, solutions);
    return solutions;
  };
  const solutions = solve(0, 0);
  return solutions.length === 1 ? solutions[0]! : null;
}

function alignPointerTextRectsWithGlyphs(
  page: AnchorPage,
  point: Position,
): readonly MappedTextRect[] | null {
  const glyphs = page.glyphs ?? [];
  const rects = page.textRects.filter(({ content, rect }) => (
    content.length > 0 && caretPointNearRect(rect, point)
  ));
  const validGlyphsByOffset = new Map<number, AnchorGlyph[]>();
  const occurrenceCache = new Map<string, readonly number[]>();
  const occurrences = (content: string): readonly number[] => {
    const cached = occurrenceCache.get(content);
    if (cached) return cached;
    const found = textOccurrences(page.extractedText, content, 0);
    occurrenceCache.set(content, found);
    return found;
  };
  for (const glyph of glyphs) {
    if (
      !Number.isSafeInteger(glyph.textOffset)
      || glyph.textOffset < 0
      || glyph.textOffset >= page.extractedText.length
      || !isValidTextRect(glyph.rect)
    ) continue;
    const existing = validGlyphsByOffset.get(glyph.textOffset) ?? [];
    existing.push(glyph);
    validGlyphsByOffset.set(glyph.textOffset, existing);
  }

  const mapped: MappedTextRect[] = [];
  for (const current of rects) {
    let content = current.content;
    let starts = occurrences(content);
    while (
      starts.length === 0
      && content.length > 1
      && PDFIUM_TRAILING_TEXT_CONTROL.test(content)
    ) {
      content = content.slice(0, -1);
      starts = occurrences(content);
    }
    if (starts.length > 1) {
      starts = starts.filter((start) => Array.from({ length: content.length }, (_, index) => start + index)
        .every((offset) => (
          !NON_WHITESPACE.test(page.extractedText[offset] ?? '')
          || validGlyphsByOffset.get(offset)?.some(({ rect }) => rectsOverlap(rect, current.rect)) === true
        )));
    }
    if (starts.length !== 1) return null;
    const start = starts[0]!;
    mapped.push({ content, rect: current.rect, start, end: start + content.length });
  }
  return mapped;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.origin.x < b.origin.x + b.size.width &&
    a.origin.x + a.size.width > b.origin.x &&
    a.origin.y < b.origin.y + b.size.height &&
    a.origin.y + a.size.height > b.origin.y
  );
}

function caretPointNearRect(rect: Rect, point: Position): boolean {
  const centerY = rect.origin.y + rect.size.height / 2;
  const tolerance = Math.min(6, rect.size.height / 2);
  return (
    Math.abs(point.y - centerY) <= tolerance
    && point.x >= rect.origin.x - tolerance
    && point.x <= rect.origin.x + rect.size.width + tolerance
  );
}

const NON_WHITESPACE = /\S/u;

function readingOrderSupported(
  mapped: readonly MappedTextRect[],
  point: Position,
): boolean {
  for (let index = 1; index < mapped.length; index += 1) {
    const previous = mapped[index - 1]!.rect;
    const current = mapped[index]!.rect;
    if (!caretPointNearRect(previous, point) && !caretPointNearRect(current, point)) continue;
    const verticalOverlap = Math.min(
      previous.origin.y + previous.size.height,
      current.origin.y + current.size.height,
    ) - Math.max(previous.origin.y, current.origin.y);
    const previousCenter = previous.origin.y + previous.size.height / 2;
    const currentCenter = current.origin.y + current.size.height / 2;
    const sameLine = verticalOverlap > 0 || Math.abs(currentCenter - previousCenter) <= Math.min(
      6,
      Math.max(previous.size.height, current.size.height) / 2,
    );
    if (sameLine && current.origin.x < previous.origin.x) return false;
    if (!sameLine && current.origin.y < previous.origin.y) return false;
  }
  return true;
}

interface CaretCandidate {
  readonly textOffset: number;
  readonly position: Rect;
  readonly distance: number;
}

function alignedCaretGlyphs(
  page: AnchorPage,
  mapped: readonly MappedTextRect[],
  point: Position,
): readonly AnchorGlyph[] | null {
  if (!page.glyphs || page.glyphs.length === 0) return null;
  const localOwners = new Map<number, MappedTextRect>();
  const requiredOffsets = new Set<number>();
  // Geometry elsewhere on a page cannot make this pointer's exact text edge ambiguous.
  for (const item of mapped) {
    if (!caretPointNearRect(item.rect, point)) continue;
    for (let offset = item.start; offset < item.end; offset += 1) {
      localOwners.set(offset, item);
      if (NON_WHITESPACE.test(page.extractedText[offset] ?? '')) requiredOffsets.add(offset);
    }
  }
  if (localOwners.size === 0) return null;
  const seenOffsets = new Set<number>();
  const aligned: AnchorGlyph[] = [];
  for (const glyph of page.glyphs) {
    const { rect, textOffset } = glyph;
    if (
      !Number.isSafeInteger(textOffset)
      || textOffset < 0
      || textOffset >= page.extractedText.length
    ) {
      if (isValidTextRect(rect) && caretPointNearRect(rect, point)) return null;
      continue;
    }
    const owner = localOwners.get(textOffset);
    // Text rectangles omit PDF control slots such as line breaks. They cannot
    // be clicked, so they do not participate in the visible-glyph contract.
    if (!owner) {
      if (isValidTextRect(rect) && caretPointNearRect(rect, point)) return null;
      continue;
    }
    const required = requiredOffsets.has(textOffset);
    if (!isValidTextRect(rect) || !rectsOverlap(rect, owner.rect)) {
      if (required) return null;
      continue;
    }
    if (seenOffsets.has(textOffset)) return null;
    seenOffsets.add(textOffset);
    requiredOffsets.delete(textOffset);
    aligned.push(glyph);
  }
  return requiredOffsets.size === 0 && aligned.length > 0 ? aligned : null;
}

function glyphCaretCandidates(
  glyphs: readonly AnchorGlyph[],
  point: Position,
): CaretCandidate[] {
  const candidates: CaretCandidate[] = [];
  const byOffset = new Map(glyphs.map((glyph) => [glyph.textOffset, glyph]));
  const boundaryX = (offset: number, fallback: number) => {
    const before = byOffset.get(offset - 1)?.rect;
    const after = byOffset.get(offset)?.rect;
    if (!before || !after) return fallback;
    const right = before.origin.x + before.size.width;
    const gap = after.origin.x - right;
    const verticalOverlap = Math.min(before.origin.y + before.size.height, after.origin.y + after.size.height)
      - Math.max(before.origin.y, after.origin.y);
    // Center in the actual inter-glyph gap, without bridging a line or column break.
    return verticalOverlap > 0 && gap >= 0 && gap <= Math.max(before.size.height, after.size.height) / 2
      ? right + gap / 2 : fallback;
  };
  for (const glyph of glyphs) {
    const { rect } = glyph;
    const centerY = rect.origin.y + rect.size.height / 2;
    const tolerance = Math.min(6, rect.size.height / 2);
    if (Math.abs(point.y - centerY) > tolerance) continue;
    const left = rect.origin.x;
    const right = rect.origin.x + rect.size.width;
    if (point.x >= left && point.x <= right) {
      const after = point.x >= left + rect.size.width / 2;
      candidates.push({
        textOffset: glyph.textOffset + (after ? 1 : 0),
        position: {
          origin: { x: boundaryX(glyph.textOffset + (after ? 1 : 0), after ? right : left), y: rect.origin.y },
          size: { width: 2, height: rect.size.height },
        },
        distance: 0,
      });
      continue;
    }
    for (const edge of [
      { x: left, textOffset: glyph.textOffset },
      { x: right, textOffset: glyph.textOffset + 1 },
    ]) {
      const distance = Math.hypot(point.x - edge.x, point.y - centerY);
      if (distance <= tolerance) {
        candidates.push({
          textOffset: edge.textOffset,
          position: {
            origin: { x: boundaryX(edge.textOffset, edge.x), y: rect.origin.y },
            size: { width: 2, height: rect.size.height },
          },
          distance,
        });
      }
    }
  }
  return candidates;
}

/**
 * Reliably maps a fresh pointer release to an exact engine text edge.
 * Without exact glyph geometry, multi-character runs remain atomic: their
 * interior never fabricates a proportional character offset.
 */
export function createCaretAnchorAtPoint(input: CreateCaretAnchorAtPointInput): CaretAnchorDiagnosticResult {
  const pageReliability = assessPageTextReliability(input.page);
  if (!pageReliability.reliable) return caretFailure(pageReliability.diagnostic);
  const scale = input.coordinateScale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0) return caretFailure('selection-geometry-invalid');
  const naturalPoint = restorePagePoint(
    input.page.size,
    input.point,
    input.coordinateRotation ?? Rotation.Degree0,
    scale,
  );
  if (!Number.isFinite(naturalPoint.x) || !Number.isFinite(naturalPoint.y)) {
    return caretFailure('selection-geometry-invalid');
  }

  const mapped = input.page.glyphs && input.page.glyphs.length > 0
    ? alignPointerTextRectsWithGlyphs(input.page, naturalPoint)
    : alignTextRects(input.page);
  if (mapped === null) return caretFailure('caret-text-rect-alignment-nonunique');
  // Subscripts and superscripts commonly overlap; reject only overlaps that can own this point.
  for (let first = 0; first < mapped.length; first += 1) {
    for (let second = first + 1; second < mapped.length; second += 1) {
      if (
        mapped[first]!.start !== mapped[second]!.start
        && rectsOverlap(mapped[first]!.rect, mapped[second]!.rect)
        && caretPointNearRect(mapped[first]!.rect, naturalPoint)
        && caretPointNearRect(mapped[second]!.rect, naturalPoint)
      ) {
        return caretFailure('caret-text-rects-overlap');
      }
    }
  }
  if (!readingOrderSupported(mapped, naturalPoint)) return caretFailure('caret-reading-order-unsupported');
  if (mapped.some(({ content, rect }) => (
    caretPointNearRect(rect, naturalPoint) && hasUnsupportedReadingOrder(content)
  ))) {
    return caretFailure('caret-reading-order-unsupported');
  }

  const exactGlyphs = alignedCaretGlyphs(input.page, mapped, naturalPoint);
  const candidates = exactGlyphs === null
    ? []
    : glyphCaretCandidates(exactGlyphs, naturalPoint);
  let insideMultiCharacterRect = false;
  for (const item of candidates.length === 0 ? mapped : []) {
    const { rect } = item;
    const centerY = rect.origin.y + rect.size.height / 2;
    const tolerance = Math.min(6, rect.size.height / 2);
    if (Math.abs(naturalPoint.y - centerY) > tolerance) continue;
    const left = rect.origin.x;
    const right = rect.origin.x + rect.size.width;
    const inside = naturalPoint.x > left + 0.001 && naturalPoint.x < right - 0.001;
    if (Array.from(item.content).length === 1 && naturalPoint.x >= left && naturalPoint.x <= right) {
      const after = naturalPoint.x >= left + rect.size.width / 2;
      candidates.push({
        textOffset: after ? item.end : item.start,
        position: {
          origin: { x: after ? right : left, y: rect.origin.y },
          size: { width: 2, height: rect.size.height },
        },
        distance: 0,
      });
      continue;
    }
    if (inside) insideMultiCharacterRect = true;
    for (const edge of [
      { x: left, textOffset: item.start },
      { x: right, textOffset: item.end },
    ]) {
      const distance = Math.hypot(naturalPoint.x - edge.x, naturalPoint.y - centerY);
      if (distance <= tolerance) {
        candidates.push({
          textOffset: edge.textOffset,
          position: {
            origin: { x: edge.x, y: rect.origin.y },
            size: { width: 2, height: rect.size.height },
          },
          distance,
        });
      }
    }
  }
  if (candidates.length === 0) {
    return caretFailure(insideMultiCharacterRect
      ? 'caret-point-inside-multichar-rect'
      : 'caret-point-out-of-tolerance');
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const chosen = candidates[0]!;
  if (
    candidates.some((candidate, index) => (
      index > 0
      && Math.abs(candidate.distance - chosen.distance) < 0.001
      && candidate.textOffset !== chosen.textOffset
    ))
  ) return caretFailure('caret-candidate-tied');

  return createCaretAnchor({
    page: input.page,
    textOffset: chosen.textOffset,
    position: chosen.position,
    coordinateRotation: Rotation.Degree0,
    ...(input.contextCharacters === undefined ? {} : { contextCharacters: input.contextCharacters }),
  });
}
