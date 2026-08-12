import { Rotation, type Position, type Rect, type Size } from '@embedpdf/models';

import {
  assessPageTextReliability,
  assessSelectionReliability,
  SELECTION_UNAVAILABLE_MESSAGE,
  type PageText,
  type ReliabilityDiagnostic,
} from './text-reliability.js';

export interface AnchorPage extends PageText {
  pageIndex: number;
  size: Size;
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
    const solutions: MappedTextRect[][] = [];
    for (const start of occurrences(current.content, offset)) {
      const mapped = {
        content: current.content,
        rect: current.rect,
        start,
        end: start + current.content.length,
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

function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.origin.x < b.origin.x + b.size.width &&
    a.origin.x + a.size.width > b.origin.x &&
    a.origin.y < b.origin.y + b.size.height &&
    a.origin.y + a.size.height > b.origin.y
  );
}

function readingOrderSupported(mapped: readonly MappedTextRect[]): boolean {
  for (let index = 1; index < mapped.length; index += 1) {
    const previous = mapped[index - 1]!.rect;
    const current = mapped[index]!.rect;
    const sameLine = Math.abs(current.origin.y - previous.origin.y) <= Math.min(6, previous.size.height / 2);
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

/**
 * Reliably maps a fresh pointer release to an exact engine text edge.
 * Multi-character runs remain atomic: their interior never fabricates a
 * proportional character offset.
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

  const mapped = alignTextRects(input.page);
  if (mapped === null) return caretFailure('caret-text-rect-alignment-nonunique');
  for (let first = 0; first < mapped.length; first += 1) {
    for (let second = first + 1; second < mapped.length; second += 1) {
      if (mapped[first]!.start !== mapped[second]!.start && rectsOverlap(mapped[first]!.rect, mapped[second]!.rect)) {
        return caretFailure('caret-text-rects-overlap');
      }
    }
  }
  if (!readingOrderSupported(mapped)) return caretFailure('caret-reading-order-unsupported');

  const candidates: CaretCandidate[] = [];
  let insideMultiCharacterRect = false;
  for (const item of mapped) {
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
    candidates[1] !== undefined &&
    Math.abs(candidates[1].distance - chosen.distance) < 0.001 &&
    candidates[1].textOffset !== chosen.textOffset
  ) return caretFailure('caret-candidate-tied');

  return createCaretAnchor({
    page: input.page,
    textOffset: chosen.textOffset,
    position: chosen.position,
    coordinateRotation: Rotation.Degree0,
    ...(input.contextCharacters === undefined ? {} : { contextCharacters: input.contextCharacters }),
  });
}
