import type { SourceAnnotationStyle, SourceAnnotationStyles } from './source-annotation-style.js';
import { nativeAnnotationsFromPages } from '../../../../packages/pdf-backends/src/native-annotations.js';
import { portableItemsFromAnnotationPages } from '../../../../packages/pdf-backends/src/embedpdf-annotation.js';
import type { PdfSpaceRect } from './selection-anchor.js';
import { isTextMarkupSubtype, markedTextFromGlyphs, type MarkedText } from './markup-text.js';
import { isNavigationalPdfAnnotationSubtype } from '../../../../packages/core/src/pdf-annotation-classification.js';
import {
  PdfAnnotationSubtype,
  PdfAnnotationSubtypeName,
  type PdfDocumentObject,
  type PdfEngine,
  type Rect,
} from '@embedpdf/models';

/** Display-only data copied from the immutable source PDF. */
export interface ExistingAnnotation {
  readonly id: string;
  readonly sourceId?: string;
  readonly sourceObjectPageIndex?: number;
  readonly sourceObjectAnnotationIndex?: number;
  readonly readerStyle?: SourceAnnotationStyle;
  readonly subtype: string;
  readonly pageIndex: number;
  readonly rect: PdfSpaceRect;
  readonly contents: string;
  readonly author: string;
  readonly flags: readonly string[];
  readonly appearanceModes: readonly string[];
  readonly supportedAppearance: boolean;
  /** Page text under a highlight, underline, squiggly or strikeout, when it could be read. */
  readonly markedText?: MarkedText;
}

export type SourceNativeAnnotation = Pick<ExistingAnnotation, 'id' | 'pageIndex' | 'readerStyle'> & {
  readonly sourceId: string;
};

export interface ExistingAnnotationSource {
  id: string;
  sourceId?: string;
  sourceObjectPageIndex?: number;
  sourceObjectAnnotationIndex?: number;
  readerStyle?: SourceAnnotationStyle;
  subtype: string;
  pageIndex: number;
  rect: PdfSpaceRect;
  contents?: string | null;
  author?: string | null;
  flags?: readonly string[];
  appearanceModes?: readonly string[];
  supportedAppearance?: boolean;
  markedText?: MarkedText;
}

/**
 * Text under markup that Placekeeper imported as editable annotations, keyed
 * by `sourceObjectPageIndex:sourceObjectAnnotationIndex`. Those annotations
 * leave the read-only inventory, so their marked words travel here instead.
 */
export type ImportedMarkedText = ReadonlyMap<string, MarkedText>;

export type ExistingAnnotationsDiscovery =
  | { readonly status: 'loading'; readonly generation: number }
  | {
      readonly status: 'ready';
      readonly generation: number;
      readonly items: readonly ExistingAnnotation[];
      readonly importedMarkedText?: ImportedMarkedText;
    }
  | {
      readonly status: 'empty';
      readonly generation: number;
      readonly items: readonly [];
      readonly importedMarkedText?: ImportedMarkedText;
    }
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
      ...(annotation.sourceObjectPageIndex === undefined ? {} : { sourceObjectPageIndex: annotation.sourceObjectPageIndex }),
      ...(annotation.sourceObjectAnnotationIndex === undefined ? {} : { sourceObjectAnnotationIndex: annotation.sourceObjectAnnotationIndex }),
      ...(annotation.readerStyle === undefined ? {} : { readerStyle: annotation.readerStyle }),
      subtype: annotation.subtype,
      pageIndex: annotation.pageIndex,
      rect: { ...annotation.rect },
      contents: annotation.contents ?? '',
      author: annotation.author ?? '',
      flags: [...(annotation.flags ?? [])],
      appearanceModes: [...(annotation.appearanceModes ?? [])],
      supportedAppearance: annotation.supportedAppearance ?? false,
      ...(annotation.markedText === undefined ? {} : { markedText: { ...annotation.markedText } }),
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
  owned: readonly (Pick<ExistingAnnotation, 'id' | 'pageIndex'> & {
    readonly sourceObjectPageIndex?: number;
    readonly sourceObjectAnnotationIndex?: number;
  })[] = [],
): readonly ExistingAnnotation[] {
  const merged = new Map<string, ExistingAnnotation>();
  const ownedKeys = new Set(owned.map(existingAnnotationKey));
  const ownedSourceObjects = new Set(owned.flatMap((annotation) =>
    annotation.sourceObjectPageIndex === undefined || annotation.sourceObjectAnnotationIndex === undefined
      ? [] : [`${annotation.sourceObjectPageIndex}:${annotation.sourceObjectAnnotationIndex}`]));
  for (const annotation of discovered) {
    if (
      !ownedKeys.has(existingAnnotationKey(annotation)) &&
      !ownedSourceObjects.has(`${annotation.sourceObjectPageIndex}:${annotation.sourceObjectAnnotationIndex}`) &&
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

export function importedMarkedTextBySourceObject(
  discovered: readonly ExistingAnnotation[],
): ImportedMarkedText {
  const imported = new Map<string, MarkedText>();
  for (const annotation of discovered) {
    if (annotation.markedText === undefined
      || annotation.sourceObjectPageIndex === undefined
      || annotation.sourceObjectAnnotationIndex === undefined) continue;
    imported.set(`${annotation.sourceObjectPageIndex}:${annotation.sourceObjectAnnotationIndex}`, annotation.markedText);
  }
  return imported;
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
    owned: readonly (Pick<ExistingAnnotation, 'id' | 'pageIndex'> & {
      readonly sourceObjectPageIndex?: number;
      readonly sourceObjectAnnotationIndex?: number;
    })[] = [],
  ): ExistingAnnotationsDiscovery | null {
    if (!this.isCurrent(token)) return null;
    const items = mergeExistingAnnotations(discovered, explicit, owned);
    const imported = importedMarkedTextBySourceObject(discovered);
    const withImported = imported.size === 0 ? {} : { importedMarkedText: imported };
    return items.length === 0
      ? { status: 'empty', generation: token.generation, items: [], ...withImported }
      : { status: 'ready', generation: token.generation, items, ...withImported };
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
  const markedTexts = await readMarkedTexts(engine, document, byPage);
  const pages = document.pages.map((_, pageIndex) => byPage[pageIndex] ?? []);
  const portable = portableItemsFromAnnotationPages(pages, { invalidMetadata: 'foreign' });
  const nativeIds = new Map(nativeAnnotationsFromPages(pages, portable.owned)
    .map(({ pageIndex, annotationIndex, item }) => [`${pageIndex}:${annotationIndex}`, item.id]));
  const sources = Object.entries(byPage).flatMap(([page, annotations]) =>
    annotations
      .map((annotation, annotationIndex) => ({
        id: nativeIds.get(`${page}:${annotationIndex}`) ?? annotation.id,
        ...(nativeIds.has(`${page}:${annotationIndex}`) ? { sourceId: annotation.id } : {}),
        ...(nativeIds.has(`${page}:${annotationIndex}`) ? {
          sourceObjectPageIndex: Number(page),
          sourceObjectAnnotationIndex: annotationIndex,
        } : {}),
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
        ...(markedTexts.has(`${page}:${annotationIndex}`)
          ? { markedText: markedTexts.get(`${page}:${annotationIndex}`)! } : {}),
      })),
  );
  return inventoryExistingAnnotations(sources);
}

type EngineAnnotationPages = Awaited<ReturnType<ReturnType<PdfEngine['getAllAnnotations']>['toPromise']>>;

function markupSegments(annotation: EngineAnnotationPages[number][number]): readonly Rect[] {
  const subtype = PdfAnnotationSubtypeName[annotation.type] ?? '';
  if (!isTextMarkupSubtype(subtype)) return [];
  const segments = 'segmentRects' in annotation && Array.isArray(annotation.segmentRects)
    ? annotation.segmentRects as Rect[]
    : [];
  return segments.length > 0 ? segments : [annotation.rect];
}

/**
 * Reads the page text under each highlight, underline, squiggly and strikeout
 * that another app wrote into the PDF. Only pages that carry such markup are
 * read. This is best effort: a page whose text cannot be read leaves its
 * annotations without marked text rather than failing the inventory.
 */
async function readMarkedTexts(
  engine: PdfEngine,
  document: PdfDocumentObject,
  byPage: EngineAnnotationPages,
): Promise<ReadonlyMap<string, MarkedText>> {
  const markedTexts = new Map<string, MarkedText>();
  await Promise.all(Object.entries(byPage).map(async ([page, annotations]) => {
    const pageIndex = Number(page);
    const markup = annotations
      .map((annotation, annotationIndex) => ({ annotationIndex, segments: markupSegments(annotation) }))
      .filter(({ segments }) => segments.length > 0);
    const pageObject = document.pages[pageIndex];
    if (markup.length === 0 || pageObject === undefined) return;
    try {
      const [text, glyphs] = await Promise.all([
        engine.extractText(document, [pageIndex]).toPromise(),
        engine.getPageGlyphs(document, pageObject).toPromise(),
      ]);
      for (const { annotationIndex, segments } of markup) {
        const marked = markedTextFromGlyphs(text, glyphs, segments);
        if (marked !== undefined) markedTexts.set(`${pageIndex}:${annotationIndex}`, marked);
      }
    } catch {
      // The annotation still shows its comment without the marked words.
    }
  }));
  return markedTexts;
}
