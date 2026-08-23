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
  createSelectionAnchor,
  type AnchorGlyph,
  type AnchorPage,
  type SelectionAnchorResult,
} from './selection-anchor.js';
import { SELECTION_UNAVAILABLE_MESSAGE } from './text-reliability.js';

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

function selectionSnapshotSignature(
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

/** Convert the public EmbedPDF selection seam into the engine-neutral anchor contract. */
export async function captureViewerSelection(
  input: CaptureViewerSelectionInput,
): Promise<SelectionAnchorResult> {
  const formatted = input.selection.getFormattedSelection(input.documentId);
  const state = input.selection.getState(input.documentId);
  const snapshotSignature = selectionSnapshotSignature(formatted, state);
  const pageIndex = formatted[0]?.pageIndex ?? 0;
  const selectedTextReading = input.selection.getSelectedText(input.documentId).toPromise();
  const [page, selectedText] = await Promise.all([
    input.pages.read(pageIndex),
    selectedTextReading,
  ]);
  const currentFormatted = input.selection.getFormattedSelection(input.documentId);
  const currentState = input.selection.getState(input.documentId);
  if (selectionSnapshotSignature(currentFormatted, currentState) !== snapshotSignature) {
    return {
      ok: false,
      userMessage: SELECTION_UNAVAILABLE_MESSAGE,
      diagnostic: 'selection-text-geometry-mismatch',
    };
  }
  const glyphCount = Object.values(state.slices).reduce((total, slice) => total + slice.count, 0);
  const selectedSlice = state.slices[pageIndex];

  return createSelectionAnchor({
    page,
    quote: selectedText.join('\n'),
    ...(selectedSlice === undefined ? {} : { quoteStart: selectedSlice.start }),
    glyphCount,
    formattedSelections: formatted.map(({ pageIndex: selectionPage, segmentRects }) => ({
      pageIndex: selectionPage,
      segmentRects,
      // The public selection capability returns unscaled page-space rectangles.
      // Page rotation is presentation state and must not be applied a second time here.
      coordinateRotation: Rotation.Degree0,
    })),
    ...(input.contextCharacters === undefined
      ? {}
      : { contextCharacters: input.contextCharacters }),
  });
}

export function createEngineAnchorPageReader(
  engine: PdfEngine,
  document: PdfDocumentObject,
): AnchorPageReader {
  const reads = new Map<number, Promise<AnchorPage>>();
  return {
    read(pageIndex) {
      const cached = reads.get(pageIndex);
      if (cached) return cached;
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
      reads.set(pageIndex, reading);
      void reading.catch(() => reads.delete(pageIndex));
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
