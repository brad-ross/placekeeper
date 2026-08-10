export const MAIN_PDF_DOCUMENT_ID = 'main';
export const REFERENCE_PDF_DOCUMENT_ID = 'reference';

export type PdfViewerScope =
  | typeof MAIN_PDF_DOCUMENT_ID
  | typeof REFERENCE_PDF_DOCUMENT_ID;
