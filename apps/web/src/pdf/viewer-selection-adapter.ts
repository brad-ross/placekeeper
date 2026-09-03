import {
  Rotation,
  type PdfDocumentObject,
  type PdfEngine,
  type PdfPageGeometry,
  type Position,
} from '@embedpdf/models';
import type {
  FormattedSelection as ViewerFormattedSelection,
  SelectionDocumentState,
} from '@embedpdf/plugin-selection';

import {
  createCaretAnchorAtPoint,
  createSelectionAnchorSpan,
  type AnchorGlyph,
  type AnchorPage,
  type SelectionAnchorResult,
} from './selection-anchor.js';
import { SELECTION_UNAVAILABLE_MESSAGE } from './text-reliability.js';
import {
  PDF_SELECTION_GEOMETRY_CACHE_PAGE_LIMIT,
  PDF_SELECTION_PAGE_LIMIT,
  PDF_SELECTION_PAGE_LIMIT_MESSAGE,
} from './selection-page-limit.js';

export interface PublicSelectionReader {
  getFormattedSelection(documentId?: string): ViewerFormattedSelection[];
  getSelectedText(documentId?: string): { toPromise(): Promise<string[]> };
  getState(documentId?: string): SelectionDocumentState;
}

export interface AnchorPageReader {
  read(pageIndex: number): Promise<AnchorPage>;
}

export interface CaptureViewerSelectionInput {
  documentId: string;
  selection: PublicSelectionReader;
  pages: AnchorPageReader;
  contextCharacters?: number;
}

export function viewerSelectionGeneration(
  formatted: readonly ViewerFormattedSelection[],
  state: SelectionDocumentState,
): string {
  const rect = ({ origin, size }: ViewerFormattedSelection['rect']) => [
    origin.x,
    origin.y,
    size.width,
    size.height,
  ];
  const pages = <Value>(values: Record<number, Value>) => Object.entries(values)
    .sort(([left], [right]) => Number(left) - Number(right));
  return JSON.stringify({
    formatted: formatted.map((selection) => ({
      pageIndex: selection.pageIndex,
      rect: rect(selection.rect),
      segmentRects: selection.segmentRects.map(rect),
    })),
    rects: pages(state.rects).map(([pageIndex, pageRects]) => [
      pageIndex,
      pageRects.map(rect),
    ]),
    selection: state.selection,
    slices: pages(state.slices),
    active: state.active,
    selecting: state.selecting,
  });
}

export interface ViewerSelectionPageEvidence {
  readonly pageIndex: number;
  readonly text: string | null;
  readonly sliceStart: number;
  readonly sliceCount: number;
  readonly geometryCached: boolean;
}

export interface ViewerSelectionEvidence {
  readonly selectionGeneration: string;
  readonly stable: boolean;
  readonly active: boolean;
  readonly selecting: boolean;
  readonly selection: SelectionDocumentState['selection'];
  readonly pageCount: number;
  readonly withinPageLimit: boolean;
  readonly formatted: ReadonlyArray<{
    readonly pageIndex: number;
    readonly rect: ViewerFormattedSelection['rect'];
    readonly segmentRects: ViewerFormattedSelection['segmentRects'];
  }>;
  readonly pages: readonly ViewerSelectionPageEvidence[];
  readonly geometryPageIndexes: readonly number[];
  readonly text: readonly string[];
}

/**
 * Read the public EmbedPDF semantic-selection seam as one generation-fenced snapshot.
 * The selection range detects every covered page independently of cache residency.
 */
export async function readViewerSelectionEvidence(
  documentId: string,
  selection: PublicSelectionReader,
): Promise<ViewerSelectionEvidence> {
  const formattedBefore = selection.getFormattedSelection(documentId);
  const stateBefore = selection.getState(documentId);
  const selectionGeneration = viewerSelectionGeneration(formattedBefore, stateBefore);
  const pageCountBefore = stateBefore.selection === null
    ? 0
    : stateBefore.selection.end.page - stateBefore.selection.start.page + 1;
  // The range itself is public evidence for enforcing the product limit. Avoid
  // materializing text which Copy and review actions are guaranteed to reject.
  const text = pageCountBefore > PDF_SELECTION_PAGE_LIMIT
    ? []
    : await selection.getSelectedText(documentId).toPromise();
  const formattedAfter = selection.getFormattedSelection(documentId);
  const stateAfter = selection.getState(documentId);
  const formatted = [...formattedAfter].sort((left, right) => left.pageIndex - right.pageIndex);
  const slices = Object.entries(stateAfter.slices)
    .map(([pageIndex, slice]) => ({ pageIndex: Number(pageIndex), ...slice }))
    .sort((left, right) => left.pageIndex - right.pageIndex);
  const pageCount = stateAfter.selection === null
    ? 0
    : stateAfter.selection.end.page - stateAfter.selection.start.page + 1;

  return {
    selectionGeneration,
    stable: viewerSelectionGeneration(formattedAfter, stateAfter) === selectionGeneration,
    active: stateAfter.active,
    selecting: stateAfter.selecting,
    selection: stateAfter.selection,
    pageCount,
    withinPageLimit: pageCount <= PDF_SELECTION_PAGE_LIMIT,
    formatted,
    pages: slices.map((slice, index) => ({
      pageIndex: slice.pageIndex,
      text: text[index] ?? null,
      sliceStart: slice.start,
      sliceCount: slice.count,
      geometryCached: stateAfter.geometry[slice.pageIndex] !== undefined,
    })),
    geometryPageIndexes: Object.keys(stateAfter.geometry)
      .map(Number)
      .sort((left, right) => left - right),
    text,
  };
}

/** Convert the public EmbedPDF selection seam into the engine-neutral anchor contract. */
export async function captureViewerSelection(
  input: CaptureViewerSelectionInput,
): Promise<SelectionAnchorResult> {
  try {
    const evidence = await readViewerSelectionEvidence(input.documentId, input.selection);
    if (evidence.stable && !evidence.withinPageLimit) {
      return {
        ok: false,
        userMessage: PDF_SELECTION_PAGE_LIMIT_MESSAGE,
        diagnostic: 'selection-page-limit-exceeded',
      };
    }
    if (
      !evidence.stable || evidence.selection === null || evidence.pages.length === 0 ||
      evidence.pages.some(({ text }) => text === null)
    ) {
      return {
        ok: false,
        userMessage: SELECTION_UNAVAILABLE_MESSAGE,
        diagnostic: 'selection-text-geometry-mismatch',
      };
    }
    const pages = await Promise.all(evidence.pages.map(({ pageIndex }) => input.pages.read(pageIndex)));
    const currentFormatted = input.selection.getFormattedSelection(input.documentId);
    const currentState = input.selection.getState(input.documentId);
    if (viewerSelectionGeneration(currentFormatted, currentState) !== evidence.selectionGeneration) {
      return {
        ok: false,
        userMessage: SELECTION_UNAVAILABLE_MESSAGE,
        diagnostic: 'selection-text-geometry-mismatch',
      };
    }
    return createSelectionAnchorSpan({
      pages: evidence.pages.map((pageEvidence, index) => ({
        page: pages[index]!,
        quote: pageEvidence.text!,
        quoteStart: pageEvidence.sliceStart,
        glyphCount: pageEvidence.sliceCount,
        formattedSelections: evidence.formatted
          .filter(({ pageIndex }) => pageIndex === pageEvidence.pageIndex)
          .map((formatted) => ({
            pageIndex: formatted.pageIndex,
            segmentRects: formatted.segmentRects,
            // Public selection geometry is already unscaled natural page space.
            coordinateRotation: Rotation.Degree0,
          })),
        ...(input.contextCharacters === undefined
          ? {}
          : { contextCharacters: input.contextCharacters }),
      })),
    });
  } catch {
    return {
      ok: false,
      userMessage: SELECTION_UNAVAILABLE_MESSAGE,
      diagnostic: 'selection-text-geometry-mismatch',
    };
  }
}

/**
 * Cache completed page reads in access order with four pages of headroom over
 * the 12-page product limit. In-flight reads are never evicted, so concurrent
 * callers share one PDFium operation; the cache returns to its bound as those
 * reads settle.
 */
export function createEngineAnchorPageReader(
  engine: PdfEngine,
  document: PdfDocumentObject,
): AnchorPageReader {
  type CacheEntry = {
    readonly reading: Promise<AnchorPage>;
    settled: boolean;
  };
  const reads = new Map<number, CacheEntry>();
  const touch = (pageIndex: number, entry: CacheEntry) => {
    reads.delete(pageIndex);
    reads.set(pageIndex, entry);
  };
  const pruneSettled = () => {
    if (reads.size <= PDF_SELECTION_GEOMETRY_CACHE_PAGE_LIMIT) return;
    for (const [pageIndex, entry] of reads) {
      if (!entry.settled) continue;
      reads.delete(pageIndex);
      if (reads.size <= PDF_SELECTION_GEOMETRY_CACHE_PAGE_LIMIT) return;
    }
  };
  return {
    read(pageIndex) {
      const cached = reads.get(pageIndex);
      if (cached) {
        touch(pageIndex, cached);
        return cached.reading;
      }
      const reading = (async () => {
        const page = document.pages[pageIndex];
        if (!page) throw new Error(`PDF page ${pageIndex} is unavailable.`);
        const [extractedText, textRects] = await Promise.all([
          engine.extractText(document, [pageIndex]).toPromise(),
          engine.getPageTextRects(document, page).toPromise(),
        ]);
        return {
          pageIndex,
          size: page.size,
          rotation: page.rotation,
          extractedText,
          textRects: textRects.map(({ content, rect }) => ({ content, rect })),
        };
      })();
      const entry: CacheEntry = { reading, settled: false };
      reads.set(pageIndex, entry);
      void reading.then(
        () => {
          entry.settled = true;
          pruneSettled();
        },
        () => {
          if (reads.get(pageIndex) === entry) reads.delete(pageIndex);
        },
      );
      return reading;
    },
  };
}

/** Reuse the selection plugin's page cache without another PDFium geometry read. */
export function anchorGlyphsFromGeometry(
  geometry: PdfPageGeometry | undefined,
): readonly AnchorGlyph[] | undefined {
  if (!geometry) return undefined;
  return geometry.runs.flatMap((run) => run.glyphs.map((glyph, index) => ({
    textOffset: run.charStart + index,
    rect: {
      origin: { x: glyph.x, y: glyph.y },
      size: { width: glyph.width, height: glyph.height },
    },
  })));
}

export async function captureViewerCaret(input: {
  readonly pageIndex: number;
  readonly point: Position;
  readonly pages: AnchorPageReader;
  readonly coordinateRotation?: Rotation;
  readonly coordinateScale?: number;
  readonly geometry?: PdfPageGeometry;
}) {
  const page = await input.pages.read(input.pageIndex);
  const glyphs = anchorGlyphsFromGeometry(input.geometry);
  return createCaretAnchorAtPoint({
    page: {
      ...page,
      ...(glyphs === undefined ? {} : { glyphs }),
    },
    point: input.point,
    ...(input.coordinateRotation === undefined ? {} : { coordinateRotation: input.coordinateRotation }),
    ...(input.coordinateScale === undefined ? {} : { coordinateScale: input.coordinateScale }),
  });
}
