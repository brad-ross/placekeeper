import type { PdfSpaceRect } from './selection-anchor.js';
import {
  PdfAnnotationSubtype,
  PdfAnnotationSubtypeName,
  type PdfDocumentObject,
  type PdfEngine,
} from '@embedpdf/models';

/** Display-only data copied from the immutable source PDF. */
export interface ExistingAnnotation {
  readonly id: string;
  readonly subtype: string;
  readonly pageIndex: number;
  readonly rect: PdfSpaceRect;
  readonly contents: string;
  readonly author: string;
  readonly flags: readonly string[];
  readonly appearanceModes: readonly string[];
  readonly supportedAppearance: boolean;
}

export interface ExistingAnnotationSource {
  id: string;
  subtype: string;
  pageIndex: number;
  rect: PdfSpaceRect;
  contents?: string | null;
  author?: string | null;
  flags?: readonly string[];
  appearanceModes?: readonly string[];
  supportedAppearance?: boolean;
}

export function inventoryExistingAnnotations(
  annotations: readonly ExistingAnnotationSource[],
): readonly ExistingAnnotation[] {
  return annotations.map((annotation) => ({
    id: annotation.id,
    subtype: annotation.subtype,
    pageIndex: annotation.pageIndex,
    rect: { ...annotation.rect },
    contents: annotation.contents ?? '',
    author: annotation.author ?? '',
    flags: [...(annotation.flags ?? [])],
    appearanceModes: [...(annotation.appearanceModes ?? [])],
    supportedAppearance: annotation.supportedAppearance ?? false,
  }));
}

/**
 * Existing annotations deliberately have no conversion to canonical review items.
 * Keeping the DTO separate prevents viewer state from becoming durable state.
 */
export function isExistingAnnotation(value: unknown): value is ExistingAnnotation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ExistingAnnotation>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.subtype === 'string' &&
    Number.isInteger(candidate.pageIndex) &&
    typeof candidate.contents === 'string'
  );
}

function appearanceModeNames(bitmask = 0): string[] {
  const modes: string[] = [];
  if ((bitmask & 1) !== 0) modes.push('normal');
  if ((bitmask & 2) !== 0) modes.push('rollover');
  if ((bitmask & 4) !== 0) modes.push('down');
  return modes;
}

export async function inventoryDocumentAnnotations(
  engine: PdfEngine,
  document: PdfDocumentObject,
): Promise<readonly ExistingAnnotation[]> {
  const byPage = await engine.getAllAnnotations(document).toPromise();
  return Object.entries(byPage).flatMap(([page, annotations]) =>
    annotations.map((annotation) => ({
      id: annotation.id,
      subtype: PdfAnnotationSubtypeName[annotation.type] ?? `Unsupported ${annotation.type}`,
      pageIndex: Number(page),
      rect: {
        x: annotation.rect.origin.x,
        y: annotation.rect.origin.y,
        width: annotation.rect.size.width,
        height: annotation.rect.size.height,
      },
      contents: annotation.contents ?? '',
      author: annotation.author ?? '',
      flags: [...(annotation.flags ?? [])],
      appearanceModes: appearanceModeNames(annotation.appearanceModes),
      supportedAppearance: annotation.type !== PdfAnnotationSubtype.UNKNOWN,
    })),
  );
}
