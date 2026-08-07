import { Rotation, type PdfDocumentObject, type PdfEngine } from '@embedpdf/models';
import type {
  FormattedSelection as ViewerFormattedSelection,
  SelectionDocumentState,
} from '@embedpdf/plugin-selection';

import {
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
  return {
    async read(pageIndex) {
      const page = document.pages[pageIndex];
      if (!page) throw new Error(`PDF page ${pageIndex} is unavailable.`);
      const [extractedText, textRects] = await Promise.all([
        engine.extractText(document, [pageIndex]).toPromise(),
        engine.getPageTextRects(document, page).toPromise(),
      ]);
      const crop = page.boxes?.crop ?? {
        left: 0,
        top: 0,
        right: page.size.width,
        bottom: page.size.height,
      };
      return {
        pageIndex,
        size: page.size,
        cropBox: crop,
        rotation: page.rotation,
        extractedText,
        textRects: textRects.map(({ content, rect }) => ({ content, rect })),
      };
    },
  };
}
