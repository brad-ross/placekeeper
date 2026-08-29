import type { PdfDocumentObject, PdfEngine } from '@embedpdf/models';

export function normalizePdfMetadataTitle(title: string | null | undefined): string | undefined {
  if (title === null || title === undefined) return undefined;
  const normalized = title.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return normalized.length === 0 ? undefined : normalized;
}

export interface PdfMetadataPageTitle {
  readonly sourceIdentity: string;
  readonly title: string;
}

export function pdfDocumentTitleForSource(
  metadataTitle: PdfMetadataPageTitle | null,
  sourceIdentity: string,
  filename: string,
): string {
  return metadataTitle?.sourceIdentity === sourceIdentity ? metadataTitle.title : filename;
}

export async function resolvePdfMetadataTitle(
  engine: PdfEngine,
  document: PdfDocumentObject,
): Promise<string | undefined> {
  try {
    const metadata = await engine.getMetadata(document).toPromise();
    return normalizePdfMetadataTitle(metadata.title);
  } catch {
    return undefined;
  }
}
