import {
  PdfErrorCode,
  PdfZoomMode,
  type PdfDocumentObject,
  type PdfEngine,
  type PdfGlyphObject,
  type PdfTask,
  type Rect,
} from '@embedpdf/models';

import type { PdfDocumentOrderLocation } from './document-order-location.js';
import {
  hasReliableGlyphGeometry,
  mergeGlyphLineSegments,
  type GlyphLineSegment,
} from './glyph-lines.js';
import {
  createPdfNavigationMetadata,
  sanitizePdfDisplayText,
} from './pdf-navigation-metadata.js';
import type { PdfNavigationTarget } from './pdf-navigation-target.js';
import { assessPageTextReliability, type TextRect } from './text-reliability.js';
import { pdfBottomOriginPointToNaturalAnchor } from './viewer-navigation.js';

/*
 * Destination description (R1, R2, R7; KTD2, KTD4–KTD7).
 *
 * Coordinates: every point and rectangle this module accepts or returns is in
 * page device space — top-left origin, PDF points, relative to the crop box —
 * the same space as `PdfLinkAnnoObject.rect`, `page.size`, and engine glyph
 * origins. XYZ destination parameters (bottom-origin PDF user space) are
 * converted with the crop-aware inverse of search's navigation point.
 */

/** Crop-aware page geometry needed to place a destination spot. */
export interface DestinationPageGeometry {
  readonly width: number;
  readonly height: number;
  readonly cropLeft: number;
  readonly cropBottom: number;
}

/** Font size and weight for a character range, used to find block breaks. */
export interface DestinationTextStyleRun {
  readonly charIndex: number;
  readonly charCount: number;
  readonly fontSize: number;
  readonly fontWeight: number;
}

/** Neutral snapshot of one page's extracted text. Glyph index = code point index. */
export interface DestinationPageText {
  readonly text: string;
  readonly glyphs: readonly PdfGlyphObject[];
  readonly textRects: readonly TextRect[];
  readonly styleRuns?: readonly DestinationTextStyleRun[];
}

/** A destination's target spot in page device space. */
export interface DestinationSpot {
  readonly x: number;
  readonly y: number;
}

export type DestinationNameSource = 'author' | 'clicked-text' | 'heading' | 'kind' | 'page';

export interface PdfDestinationDescription {
  readonly documentGeneration: number;
  readonly targetIdentity: string;
  readonly pageIndex: number;
  /** The bare one-based page numeral, for example "14". */
  readonly pageNumeral: string;
  /** Null for whole-page destinations (KTD4). */
  readonly spot: DestinationSpot | null;
  /** One rectangle per line of the target block; null when no spot or unreliable text. */
  readonly extent: readonly Rect[] | null;
  readonly clickedText: string | null;
  readonly heading: string | null;
  readonly kindLabel: string | null;
  /** Sanitized, bounded plain-text name for a References tab (R7). */
  readonly name: string;
  readonly nameSource: DestinationNameSource;
}

export interface DescribePdfDestinationInput {
  readonly target: PdfNavigationTarget;
  readonly geometry: DestinationPageGeometry;
  /** Destination page text, or null when it could not be read. */
  readonly destinationText: DestinationPageText | null;
  /** Source page text (the page holding the clicked link), or null. */
  readonly sourceText: DestinationPageText | null;
  /**
   * Same-page link areas sharing the clicked link's target identity, in
   * reading order, in source page device space.
   */
  readonly sourceRects: readonly Rect[];
  /** The containing section heading from the outline resolver, or null. */
  readonly heading: string | null;
  readonly contents?: unknown;
  readonly subject?: unknown;
}

const MAX_EXTENT_LINES = 3;
const BLOCK_PITCH_FACTOR = 1.5;
const SPOT_BOTTOM_MARGIN = 1;
const INDENT_TOLERANCE = 2;
const FONT_SIZE_TOLERANCE = 0.5;
const HEIGHT_CHANGE_RATIO = 0.2;
const SOURCE_RECT_TOLERANCE = 1;

function finite(...values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

function validGeometry(geometry: DestinationPageGeometry): boolean {
  return finite(geometry.width, geometry.height, geometry.cropLeft, geometry.cropBottom)
    && geometry.width > 0
    && geometry.height > 0;
}

/**
 * KTD4: a spot exists only for an XYZ destination whose y lies inside the crop
 * box and more than one point above its bottom edge. The engine turns a null
 * XYZ top into y = 0, so null-top XYZ, Fit, and FitH are whole-page.
 */
export function destinationSpot(
  target: PdfNavigationTarget,
  geometry: DestinationPageGeometry,
): DestinationSpot | null {
  if (target.zoom.mode !== PdfZoomMode.XYZ || target.zoom.params.length !== 3) return null;
  if (!validGeometry(geometry)) return null;
  const [x, y] = target.zoom.params;
  if (x === undefined || y === undefined || !finite(x, y)) return null;
  const cropTop = geometry.cropBottom + geometry.height;
  if (y <= geometry.cropBottom + SPOT_BOTTOM_MARGIN || y > cropTop) return null;
  const anchor = pdfBottomOriginPointToNaturalAnchor(
    { x, y },
    geometry,
    { x: geometry.cropLeft, y: geometry.cropBottom },
  );
  return {
    x: Math.min(Math.max(anchor.x, 0), geometry.width),
    y: anchor.y,
  };
}

/**
 * The document-order location an outline containment resolver should use for
 * this destination: the spot, or the top of the page for whole-page targets.
 */
export function destinationOrderLocation(
  target: PdfNavigationTarget,
  spot: DestinationSpot | null,
): PdfDocumentOrderLocation {
  return {
    pageIndex: target.pageIndex,
    anchor: spot === null ? { x: 0, y: 0 } : { x: spot.x, y: spot.y },
  };
}

/** KTD6: text with no run of two or more letters reads as a number or reference code. */
export function isReferenceCode(text: string): boolean {
  return !/\p{L}{2,}/u.test(text);
}

function reliablePageText(page: DestinationPageText | null): page is DestinationPageText {
  if (page === null) return false;
  return assessPageTextReliability({ extractedText: page.text, textRects: page.textRects }).reliable
    && page.glyphs.length > 0
    && hasReliableGlyphGeometry(page.glyphs);
}

// ---------------------------------------------------------------------------
// Lines and blocks (KTD5)
// ---------------------------------------------------------------------------

type PageLine = GlyphLineSegment;

/**
 * Line segments for the whole page. Extracted text breaks lines with CR/LF, so
 * glyphs merge only within one extracted line; tight leading cannot fuse
 * adjacent lines into one segment.
 */
function pageLines(
  glyphs: readonly PdfGlyphObject[],
  characters: readonly string[],
): PageLine[] {
  const lines: PageLine[] = [];
  let start = 0;
  const count = Math.min(glyphs.length, characters.length);
  for (let index = 0; index <= count; index += 1) {
    if (index === count || characters[index] === '\n' || characters[index] === '\r') {
      if (index > start) lines.push(...mergeGlyphLineSegments(glyphs, start, index));
      start = index + 1;
    }
  }
  return lines;
}

function centerY(rect: Rect): number {
  return rect.origin.y + rect.size.height / 2;
}

/**
 * Text of a line plus any following segments on the same baseline band to its
 * right, so a far-right equation number reads with its equation.
 */
function rowText(lines: readonly PageLine[], index: number, characters: readonly string[]): string {
  const first = lines[index]!;
  let end = first.end;
  let right = first.rect;
  for (let next = index + 1; next < lines.length; next += 1) {
    const segment = lines[next]!.rect;
    if (
      Math.abs(centerY(right) - centerY(segment)) > Math.min(right.size.height, segment.size.height) / 2
      || segment.origin.x < right.origin.x + right.size.width
    ) break;
    end = lines[next]!.end;
    right = segment;
  }
  return characters.slice(first.start, end).join('').replace(/\s+/gu, ' ').trim();
}

function horizontalOverlap(first: Rect, second: Rect): boolean {
  return first.origin.x < second.origin.x + second.size.width
    && second.origin.x < first.origin.x + first.size.width;
}

function horizontalDistance(rect: Rect, x: number): number {
  if (x < rect.origin.x) return rect.origin.x - x;
  const right = rect.origin.x + rect.size.width;
  return x > right ? x - right : 0;
}

function medianLinePitch(lines: readonly PageLine[]): number | null {
  const pitches: number[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1]!.rect;
    const current = lines[index]!.rect;
    const pitch = current.origin.y - previous.origin.y;
    if (pitch > 0 && horizontalOverlap(previous, current)) pitches.push(pitch);
  }
  if (pitches.length === 0) return null;
  pitches.sort((left, right) => left - right);
  const middle = Math.floor(pitches.length / 2);
  return pitches.length % 2 === 1
    ? pitches[middle]!
    : (pitches[middle - 1]! + pitches[middle]!) / 2;
}

/**
 * KTD5: the first line whose top is at or below the spot. Lines that end left
 * of the spot belong to an earlier column. Among lines on the nearest row,
 * the one horizontally closest to the spot wins.
 */
function targetLineIndex(lines: readonly PageLine[], spot: DestinationSpot): number | null {
  const candidates = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => (
      line.rect.origin.y >= spot.y - line.rect.size.height / 2
      && line.rect.origin.x + line.rect.size.width >= spot.x - INDENT_TOLERANCE
    ));
  if (candidates.length === 0) return null;
  const nearestTop = Math.min(...candidates.map(({ line }) => line.rect.origin.y));
  let best: { readonly line: PageLine; readonly index: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.line.rect.origin.y > nearestTop + candidate.line.rect.size.height / 2) continue;
    if (
      best === null
      || horizontalDistance(candidate.line.rect, spot.x) < horizontalDistance(best.line.rect, spot.x)
    ) best = candidate;
  }
  return best?.index ?? null;
}

interface LineStyle {
  readonly fontSize: number;
  readonly fontWeight: number;
}

function lineStyle(line: PageLine, runs: readonly DestinationTextStyleRun[] | undefined): LineStyle | null {
  if (!runs || runs.length === 0) return null;
  const weights = new Map<string, number>();
  for (const run of runs) {
    if (!finite(run.charIndex, run.charCount, run.fontSize, run.fontWeight)) continue;
    const overlap = Math.min(line.end, run.charIndex + run.charCount) - Math.max(line.start, run.charIndex);
    if (overlap <= 0) continue;
    const key = `${run.fontSize}|${run.fontWeight}`;
    weights.set(key, (weights.get(key) ?? 0) + overlap);
  }
  let dominant: string | null = null;
  let count = 0;
  for (const [key, value] of weights) {
    if (value > count) {
      dominant = key;
      count = value;
    }
  }
  if (dominant === null) return null;
  const [fontSize, fontWeight] = dominant.split('|').map(Number);
  return { fontSize: fontSize!, fontWeight: fontWeight! };
}

function sameStyle(
  first: PageLine,
  second: PageLine,
  runs: readonly DestinationTextStyleRun[] | undefined,
): boolean {
  const firstStyle = lineStyle(first, runs);
  const secondStyle = lineStyle(second, runs);
  if (firstStyle !== null && secondStyle !== null) {
    return Math.abs(firstStyle.fontSize - secondStyle.fontSize) <= FONT_SIZE_TOLERANCE
      && firstStyle.fontWeight === secondStyle.fontWeight;
  }
  // Without style runs, fall back to comparable glyph heights.
  const larger = Math.max(first.rect.size.height, second.rect.size.height);
  return Math.abs(first.rect.size.height - second.rect.size.height) <= larger * HEIGHT_CHANGE_RATIO;
}

function blockLines(
  lines: readonly PageLine[],
  startIndex: number,
  runs: readonly DestinationTextStyleRun[] | undefined,
): PageLine[] {
  const opening = lines[startIndex]!;
  const block = [opening];
  const pitch = medianLinePitch(lines);
  if (pitch === null) return block;
  let leftOpeningIndent = false;
  for (let index = startIndex + 1; index < lines.length && block.length < MAX_EXTENT_LINES; index += 1) {
    const previous = block.at(-1)!;
    const next = lines[index]!;
    const gap = next.rect.origin.y - previous.rect.origin.y;
    if (gap <= 0 || gap > pitch * BLOCK_PITCH_FACTOR) break;
    if (!horizontalOverlap(opening.rect, next.rect)) break;
    if (!sameStyle(previous, next, runs)) break;
    const atOpeningIndent = Math.abs(next.rect.origin.x - opening.rect.origin.x) <= INDENT_TOLERANCE;
    // A return to the opening indent after an indented line (a hanging
    // indent) starts the next bibliography entry.
    if (atOpeningIndent && leftOpeningIndent) break;
    if (!atOpeningIndent) leftOpeningIndent = true;
    block.push(next);
  }
  return block;
}

interface TargetBlock {
  readonly lines: readonly PageLine[];
  readonly targetLineText: string;
}

function resolveTargetBlock(page: DestinationPageText, spot: DestinationSpot): TargetBlock | null {
  const characters = Array.from(page.text);
  const lines = pageLines(page.glyphs, characters);
  const index = targetLineIndex(lines, spot);
  if (index === null) return null;
  return {
    lines: blockLines(lines, index, page.styleRuns),
    targetLineText: rowText(lines, index, characters),
  };
}

// ---------------------------------------------------------------------------
// Clicked text (KTD6)
// ---------------------------------------------------------------------------

function glyphInside(glyph: PdfGlyphObject, rect: Rect): boolean {
  const x = glyph.origin.x + glyph.size.width / 2;
  const y = glyph.origin.y + glyph.size.height / 2;
  return x >= rect.origin.x - SOURCE_RECT_TOLERANCE
    && x <= rect.origin.x + rect.size.width + SOURCE_RECT_TOLERANCE
    && y >= rect.origin.y - SOURCE_RECT_TOLERANCE
    && y <= rect.origin.y + rect.size.height + SOURCE_RECT_TOLERANCE;
}

function validRect(rect: Rect): boolean {
  return finite(rect.origin.x, rect.origin.y, rect.size.width, rect.size.height)
    && rect.size.width > 0
    && rect.size.height > 0;
}

function clickedText(page: DestinationPageText | null, rects: readonly Rect[]): string | null {
  if (rects.length === 0 || !reliablePageText(page)) return null;
  const usable = rects.filter(validRect);
  if (usable.length === 0) return null;
  const indexes: number[] = [];
  page.glyphs.forEach((glyph, index) => {
    if (glyph.isEmpty || glyph.isSpace) return;
    if (usable.some((rect) => glyphInside(glyph, rect))) indexes.push(index);
  });
  if (indexes.length === 0) return null;
  const characters = Array.from(page.text);
  const runs: string[] = [];
  let runStart = indexes[0]!;
  let runEnd = runStart + 1;
  for (const index of indexes.slice(1)) {
    const between = characters.slice(runEnd, index).join('');
    if (/^\s*$/u.test(between)) {
      runEnd = index + 1;
      continue;
    }
    runs.push(characters.slice(runStart, runEnd).join(''));
    runStart = index;
    runEnd = index + 1;
  }
  runs.push(characters.slice(runStart, runEnd).join(''));
  return sanitizePdfDisplayText(runs.join(' '));
}

// ---------------------------------------------------------------------------
// Kind labels and naming (R7, KTD7)
// ---------------------------------------------------------------------------

const NUMBER = String.raw`\d+(?:\.\d+)*[a-z]?`;
const CAPTION = new RegExp(String.raw`^(Figure|Fig\.|Table)\s*(${NUMBER})\b`, 'iu');
const EQUATION = new RegExp(String.raw`\((${NUMBER})\)$`, 'iu');

function referenceNumber(text: string): string | null {
  const match = new RegExp(String.raw`^[([]?(${NUMBER})[)\]]?$`, 'iu').exec(text.trim());
  return match?.[1] ?? null;
}

function kindLabel(lineText: string, clicked: string | null): string | null {
  const caption = CAPTION.exec(lineText);
  if (caption) {
    const word = caption[1]!.toLowerCase().startsWith('t') ? 'Table' : 'Figure';
    return `${word} ${caption[2]}`;
  }
  const number = clicked === null ? null : referenceNumber(clicked);
  if (number !== null && lineText.startsWith(number)) {
    const after = lineText.charAt(number.length);
    if (after === '' || /\s/u.test(after)) return `Section ${number}`;
  }
  const equation = EQUATION.exec(lineText);
  if (equation) return `Eq. ${equation[1]}`;
  return null;
}

/** Pure core: turns one link invocation plus page text into a destination description. */
export function describePdfDestination(input: DescribePdfDestinationInput): PdfDestinationDescription {
  const { target } = input;
  const pageNumeral = String(target.pageIndex + 1);
  const spot = destinationSpot(target, input.geometry);
  const block = spot !== null && reliablePageText(input.destinationText)
    ? resolveTargetBlock(input.destinationText, spot)
    : null;
  const extent = block === null ? null : block.lines.map(({ rect }) => rect);
  const clicked = clickedText(input.sourceText, input.sourceRects);
  const heading = sanitizePdfDisplayText(input.heading);
  const kind = block === null || block.targetLineText.length === 0
    ? null
    : sanitizePdfDisplayText(kindLabel(block.targetLineText, clicked));

  const author = createPdfNavigationMetadata({
    contents: input.contents,
    subject: input.subject,
    pageIndex: target.pageIndex,
  }).authorLabel;
  const [name, nameSource]: readonly [string, DestinationNameSource] = author !== null
    ? [author, 'author']
    : clicked !== null && !isReferenceCode(clicked)
      ? [clicked, 'clicked-text']
      : heading !== null
        ? [heading, 'heading']
        : kind !== null
          ? [kind, 'kind']
          : [pageNumeral, 'page'];

  return {
    documentGeneration: target.documentGeneration,
    targetIdentity: target.identity,
    pageIndex: target.pageIndex,
    pageNumeral,
    spot,
    extent,
    clickedText: clicked,
    heading,
    kindLabel: kind,
    name,
    nameSource,
  };
}

// ---------------------------------------------------------------------------
// Engine-backed reader and resolver (name stage of KTD2)
// ---------------------------------------------------------------------------

export interface DestinationPageReader {
  readonly pageCount: number;
  geometry(pageIndex: number): DestinationPageGeometry | null;
  read(pageIndex: number, signal: AbortSignal): Promise<DestinationPageText>;
  dispose?(): void;
}

export interface DestinationDescriptionRequest {
  readonly target: PdfNavigationTarget;
  readonly sourcePageIndex: number;
  /** Same-page link areas sharing the target identity, in reading order. */
  readonly sourceRects: readonly Rect[];
  readonly contents?: unknown;
  readonly subject?: unknown;
}

export interface DestinationDescriptionResolver {
  /** Resolves null for stale, aborted, out-of-range, or disposed requests. */
  resolve(
    request: DestinationDescriptionRequest,
    signal: AbortSignal,
  ): Promise<PdfDestinationDescription | null>;
  dispose(): void;
}

export interface CreateDestinationDescriptionResolverOptions {
  readonly documentGeneration: number;
  readonly reader: DestinationPageReader;
  /**
   * Returns the containing outline heading for a destination location, or
   * null. Build it from `createOutlineContainmentResolver` for the same
   * document generation; failures count as no heading.
   */
  readonly resolveHeading?: (location: PdfDocumentOrderLocation) => string | null;
}

const DEFAULT_PAGE_CACHE_SIZE = 8;

function abortableTask<T>(task: PdfTask<T, unknown> | PdfTask<T>, signal: AbortSignal): Promise<T> {
  const abort = () => {
    try {
      task.abort({ code: PdfErrorCode.Cancelled, message: 'Destination description cancelled' });
    } catch { /* task already settled */ }
  };
  if (signal.aborted) abort();
  signal.addEventListener('abort', abort, { once: true });
  return task.toPromise().finally(() => signal.removeEventListener('abort', abort));
}

/**
 * Reads destination and source page text from the engine for one document
 * generation, keeping a small LRU of settled pages. Style runs are optional:
 * a failed run read degrades to glyph-height block detection.
 */
export function createEngineDestinationPageReader(
  engine: PdfEngine,
  document: PdfDocumentObject,
  options: { readonly maxCachedPages?: number } = {},
): DestinationPageReader {
  const maxCachedPages = Math.max(1, options.maxCachedPages ?? DEFAULT_PAGE_CACHE_SIZE);
  const cache = new Map<number, Promise<DestinationPageText>>();
  const disposal = new AbortController();

  const load = async (pageIndex: number): Promise<DestinationPageText> => {
    const page = document.pages[pageIndex];
    if (!page) throw new Error(`PDF page ${pageIndex} is unavailable.`);
    const signal = disposal.signal;
    const [text, glyphs, textRects] = await Promise.all([
      abortableTask(engine.extractText(document, [pageIndex]), signal),
      abortableTask(engine.getPageGlyphs(document, page), signal),
      abortableTask(engine.getPageTextRects(document, page), signal),
    ]);
    let styleRuns: DestinationTextStyleRun[] | undefined;
    try {
      const runs = await abortableTask(engine.getPageTextRuns(document, page), signal);
      styleRuns = runs.runs.map((run) => ({
        charIndex: run.charIndex,
        charCount: run.charCount,
        fontSize: run.fontSize,
        fontWeight: run.font.weight,
      }));
    } catch {
      if (signal.aborted) throw new Error('Destination page reader disposed.');
      styleRuns = undefined;
    }
    return {
      text,
      glyphs,
      textRects: textRects.map(({ content, rect }) => ({ content, rect })),
      ...(styleRuns ? { styleRuns } : {}),
    };
  };

  return {
    pageCount: document.pages.length,
    geometry(pageIndex) {
      const page = document.pages[pageIndex];
      if (!page) return null;
      return {
        width: page.size.width,
        height: page.size.height,
        cropLeft: page.boxes?.crop.left ?? 0,
        cropBottom: page.boxes?.crop.bottom ?? 0,
      };
    },
    read(pageIndex, signal) {
      if (disposal.signal.aborted) return Promise.reject(new Error('Destination page reader disposed.'));
      let pending = cache.get(pageIndex);
      if (pending) {
        cache.delete(pageIndex);
        cache.set(pageIndex, pending);
      } else {
        pending = load(pageIndex);
        pending.catch(() => {
          if (cache.get(pageIndex) === pending) cache.delete(pageIndex);
        });
        cache.set(pageIndex, pending);
        while (cache.size > maxCachedPages) cache.delete(cache.keys().next().value!);
      }
      // A caller's abort stops waiting; the shared read settles into the cache.
      return new Promise<DestinationPageText>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('Destination page read aborted.'));
          return;
        }
        const onAbort = () => reject(new Error('Destination page read aborted.'));
        signal.addEventListener('abort', onAbort, { once: true });
        pending!.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
      });
    },
    dispose() {
      disposal.abort();
      cache.clear();
    },
  };
}

/** Resolves the name stage of a destination description for one document generation. */
export function createDestinationDescriptionResolver(
  options: CreateDestinationDescriptionResolverOptions,
): DestinationDescriptionResolver {
  let disposed = false;
  const readOrNull = async (pageIndex: number, signal: AbortSignal) => {
    try {
      return await options.reader.read(pageIndex, signal);
    } catch {
      return null;
    }
  };
  const inRange = (pageIndex: number) => Number.isSafeInteger(pageIndex)
    && pageIndex >= 0
    && pageIndex < options.reader.pageCount;

  return {
    async resolve(request, signal) {
      const { target } = request;
      if (
        disposed
        || signal.aborted
        || target.documentGeneration !== options.documentGeneration
        || !inRange(target.pageIndex)
      ) return null;
      const geometry = options.reader.geometry(target.pageIndex);
      if (geometry === null) return null;
      const readSource = inRange(request.sourcePageIndex) && request.sourceRects.length > 0;
      const [destinationText, sourceText] = await Promise.all([
        readOrNull(target.pageIndex, signal),
        readSource ? readOrNull(request.sourcePageIndex, signal) : Promise.resolve(null),
      ]);
      if (disposed || signal.aborted) return null;
      let heading: string | null = null;
      try {
        heading = options.resolveHeading?.(
          destinationOrderLocation(target, destinationSpot(target, geometry)),
        ) ?? null;
      } catch {
        heading = null;
      }
      return describePdfDestination({
        target,
        geometry,
        destinationText,
        sourceText,
        sourceRects: request.sourceRects,
        heading,
        contents: request.contents,
        subject: request.subject,
      });
    },
    dispose() {
      disposed = true;
      options.reader.dispose?.();
    },
  };
}
