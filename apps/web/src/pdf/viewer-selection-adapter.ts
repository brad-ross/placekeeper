import { Rotation, type PdfDocumentObject, type PdfEngine, type Position } from '@embedpdf/models';
import type {
  FormattedSelection as ViewerFormattedSelection,
  SelectionDocumentState,
} from '@embedpdf/plugin-selection';

import {
  createCaretAnchorAtPoint,
  createSelectionAnchor,
  type AnchorPage,
  type SelectionAnchorResult,
} from './selection-anchor.js';

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

/** Convert the public EmbedPDF selection seam into the engine-neutral anchor contract. */
export async function captureViewerSelection(
  input: CaptureViewerSelectionInput,
): Promise<SelectionAnchorResult> {
  const formatted = input.selection.getFormattedSelection(input.documentId);
  const pageIndex = formatted[0]?.pageIndex ?? 0;
  const page = await input.pages.read(pageIndex);
  const selectedText = await input.selection.getSelectedText(input.documentId).toPromise();
  const state = input.selection.getState(input.documentId);
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

export async function captureViewerCaret(input: {
  readonly pageIndex: number;
  readonly point: Position;
  readonly pages: AnchorPageReader;
  readonly coordinateRotation?: Rotation;
  readonly coordinateScale?: number;
}) {
  const page = await input.pages.read(input.pageIndex);
  return createCaretAnchorAtPoint({
    page,
    point: input.point,
    ...(input.coordinateRotation === undefined ? {} : { coordinateRotation: input.coordinateRotation }),
    ...(input.coordinateScale === undefined ? {} : { coordinateScale: input.coordinateScale }),
  });
}
