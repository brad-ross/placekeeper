import type { SourceAnnotationStyle, SourceAnnotationStyles } from './source-annotation-style.js';
import { nativeAnnotationsFromPages } from '../../../../packages/pdf-backends/src/native-annotations.js';
import { portableItemsFromAnnotationPages } from '../../../../packages/pdf-backends/src/embedpdf-annotation.js';
import type { PdfSpaceRect } from './selection-anchor.js';
import { isNavigationalPdfAnnotationSubtype } from '../../../../packages/core/src/pdf-annotation-classification.js';
import {
  PdfAnnotationSubtype,
  PdfAnnotationSubtypeName,
  type PdfDocumentObject,
  type PdfEngine,
} from '@embedpdf/models';

/** Display-only data copied from the immutable source PDF. */
export interface ExistingAnnotation {
  readonly id: string;
  readonly sourceId?: string;
  readonly readerStyle?: SourceAnnotationStyle;
  readonly subtype: string;
  readonly pageIndex: number;
  readonly rect: PdfSpaceRect;
  readonly contents: string;
  readonly author: string;
  readonly flags: readonly string[];
  readonly appearanceModes: readonly string[];
  readonly supportedAppearance: boolean;
}

export type SourceNativeAnnotation = Pick<ExistingAnnotation, 'id' | 'pageIndex' | 'readerStyle'> & {
  readonly sourceId: string;
};

export interface ExistingAnnotationSource {
  id: string;
  sourceId?: string;
  readerStyle?: SourceAnnotationStyle;
  subtype: string;
  pageIndex: number;
  rect: PdfSpaceRect;
  contents?: string | null;
  author?: string | null;
  flags?: readonly string[];
  appearanceModes?: readonly string[];
  supportedAppearance?: boolean;
}

export type ExistingAnnotationsDiscovery =
  | { readonly status: 'loading'; readonly generation: number }
  | { readonly status: 'ready'; readonly generation: number; readonly items: readonly ExistingAnnotation[] }
  | { readonly status: 'empty'; readonly generation: number; readonly items: readonly [] }
  | { readonly status: 'error'; readonly generation: number; readonly message: string };

export interface ExistingAnnotationDiscoveryToken {
  readonly documentKey: string;
  readonly generation: number;
}

export function inventoryExistingAnnotations(
  annotations: readonly ExistingAnnotationSource[],
): readonly ExistingAnnotation[] {
  return annotations
    .filter(({ subtype }) => !isNavigationalPdfAnnotationSubtype(subtype) && !['popup', 'widget', 'xfawidget'].includes(subtype.toLowerCase()))
    .map((annotation) => ({
      id: annotation.id,
      ...(annotation.sourceId === undefined ? {} : { sourceId: annotation.sourceId }),
      ...(annotation.readerStyle === undefined ? {} : { readerStyle: annotation.readerStyle }),
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

export function existingAnnotationKey(
  annotation: Pick<ExistingAnnotation, 'id' | 'pageIndex'>,
): string {
  return `${annotation.pageIndex}:${annotation.id}`;
}

export function mergeExistingAnnotations(
  discovered: readonly ExistingAnnotation[],
  explicit: readonly ExistingAnnotation[],
  owned: readonly Pick<ExistingAnnotation, 'id' | 'pageIndex'>[] = [],
): readonly ExistingAnnotation[] {
  const merged = new Map<string, ExistingAnnotation>();
  const ownedKeys = new Set(owned.map(existingAnnotationKey));
  for (const annotation of discovered) {
    if (
      !ownedKeys.has(existingAnnotationKey(annotation)) &&
      !isNavigationalPdfAnnotationSubtype(annotation.subtype)
    ) {
      merged.set(existingAnnotationKey(annotation), annotation);
    }
  }
  for (const annotation of explicit) {
    if (isNavigationalPdfAnnotationSubtype(annotation.subtype)) continue;
    const key = existingAnnotationKey(annotation);
    if (!ownedKeys.has(key) && !merged.has(key)) merged.set(key, annotation);
  }
  return [...merged.values()];
}

/** Generation authority keeps late inventory reads from replacing current document state. */
export class ExistingAnnotationDiscoveryAuthority {
  #generation = 0;
  #current: ExistingAnnotationDiscoveryToken | null = null;

  begin(documentKey: string): ExistingAnnotationDiscoveryToken {
    const token = { documentKey, generation: ++this.#generation };
    this.#current = token;
    return token;
  }

  isCurrent(token: ExistingAnnotationDiscoveryToken): boolean {
    return this.#current?.documentKey === token.documentKey &&
      this.#current.generation === token.generation;
  }

  ready(
    token: ExistingAnnotationDiscoveryToken,
    discovered: readonly ExistingAnnotation[],
    explicit: readonly ExistingAnnotation[],
    owned: readonly Pick<ExistingAnnotation, 'id' | 'pageIndex'>[] = [],
  ): ExistingAnnotationsDiscovery | null {
    if (!this.isCurrent(token)) return null;
    const items = mergeExistingAnnotations(discovered, explicit, owned);
    return items.length === 0
      ? { status: 'empty', generation: token.generation, items: [] }
      : { status: 'ready', generation: token.generation, items };
  }

  error(token: ExistingAnnotationDiscoveryToken, error: unknown): ExistingAnnotationsDiscovery | null {
    if (!this.isCurrent(token)) return null;
    return {
      status: 'error',
      generation: token.generation,
      message: error instanceof Error ? error.message : 'Existing annotation inventory failed.',
    };
  }
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
  styles?: SourceAnnotationStyles | Promise<SourceAnnotationStyles>,
): Promise<readonly ExistingAnnotation[]> {
  const [byPage, sourceStyles] = await Promise.all([engine.getAllAnnotations(document).toPromise(), styles]);
  const pages = document.pages.map((_, pageIndex) => byPage[pageIndex] ?? []);
  const portable = portableItemsFromAnnotationPages(pages, { invalidMetadata: 'foreign' });
  const nativeIds = new Map(nativeAnnotationsFromPages(pages, portable.owned)
    .map(({ pageIndex, annotationIndex, item }) => [`${pageIndex}:${annotationIndex}`, item.id]));
  const sources = Object.entries(byPage).flatMap(([page, annotations]) =>
    annotations
      .map((annotation, annotationIndex) => ({
        id: nativeIds.get(`${page}:${annotationIndex}`) ?? annotation.id,
        ...(nativeIds.has(`${page}:${annotationIndex}`) ? { sourceId: annotation.id } : {}),
        ...(sourceStyles?.pageAnnotationCounts[Number(page)] === annotations.length && sourceStyles.byIndex.has(`${page}:${annotationIndex}`)
          ? { readerStyle: sourceStyles.byIndex.get(`${page}:${annotationIndex}`)! } : {}),
        subtype: PdfAnnotationSubtypeName[annotation.type] ?? `Unsupported ${annotation.type}`,
        pageIndex: Number(page),
        rect: {
          x: annotation.rect.origin.x,
          y: annotation.rect.origin.y,
          width: annotation.rect.size.width,
          height: annotation.rect.size.height,
        },
        ...(annotation.contents === undefined ? {} : { contents: annotation.contents }),
        ...(annotation.author === undefined ? {} : { author: annotation.author }),
        ...(annotation.flags === undefined ? {} : { flags: annotation.flags }),
        appearanceModes: appearanceModeNames(annotation.appearanceModes),
        supportedAppearance: annotation.type !== PdfAnnotationSubtype.UNKNOWN,
      })),
  );
  return inventoryExistingAnnotations(sources);
}
