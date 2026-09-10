import { nativePdfAnnotationSubtype, canEditPdfAnnotationComment } from '../../../../packages/core/src/native-pdf-annotation.js';
import type { ReviewItem } from '../../../../packages/core/src/review-model.js';
import {
  existingAnnotationKey,
  type ExistingAnnotation,
  type ExistingAnnotationsDiscovery,
} from '../pdf/existing-annotations.js';
import { annotationKindLabel } from './AnnotationMetadata.js';
import { annotationContent, type AnnotationContent } from './annotation-content.js';
import { reviewItemPageRange } from './annotation-projection.js';

export type AnnotationReaderIdentity =
  | {
      readonly origin: 'owned';
      readonly itemId: string;
    }
  | {
      readonly origin: 'source';
      readonly annotationKey: string;
      readonly documentGeneration: number;
      readonly discoveryGeneration: number;
    };

interface AnnotationReaderRecordBase extends AnnotationContent {
  readonly identity: AnnotationReaderIdentity;
  readonly origin: 'owned' | 'source';
  readonly kind: string;
  readonly typeLabel: string;
  readonly pageNumber: number;
  readonly lastPageNumber?: number;
  readonly sectionLabel?: string;
  readonly contentLabel:
    | 'Deleted text'
    | 'Replacement text'
    | 'Insertion text'
    | 'Comment'
    | 'Page note'
    | 'Annotation contents';
  readonly content: string;
}

export interface OwnedAnnotationReaderRecord extends AnnotationReaderRecordBase {
  readonly identity: Extract<AnnotationReaderIdentity, { readonly origin: 'owned' }>;
  readonly origin: 'owned';
  readonly mutable: boolean;
}

export interface ExistingAnnotationReaderRecord extends AnnotationReaderRecordBase {
  readonly identity: Extract<AnnotationReaderIdentity, { readonly origin: 'source' }>;
  readonly origin: 'source';
  readonly author?: string;
  readonly mutable: false;
}

export type AnnotationReaderRecord =
  | OwnedAnnotationReaderRecord
  | ExistingAnnotationReaderRecord;

function nonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function ownedContentLabel(kind: ReviewItem['kind']): OwnedAnnotationReaderRecord['contentLabel'] {
  switch (kind) {
    case 'replace': return 'Replacement text';
    case 'insert': return 'Insertion text';
    case 'highlight':
    case 'pdfAnnotation': return 'Comment';
    case 'pageNote': return 'Page note';
    case 'delete': return 'Deleted text';
  }
}

export function projectOwnedAnnotationReader(
  item: ReviewItem,
  sectionLabel?: string,
): OwnedAnnotationReaderRecord | null {
  const presentation = annotationContent(item);
  if (![presentation.content, presentation.sourceText, presentation.quoteText].some(nonBlankString)) return null;
  const visibleSectionLabel = nonBlankString(sectionLabel);
  const { firstPageIndex, lastPageIndex } = reviewItemPageRange(item);

  return {
    identity: { origin: 'owned', itemId: item.id },
    origin: 'owned',
    kind: item.kind,
    typeLabel: annotationKindLabel(nativePdfAnnotationSubtype(item) ?? item.kind),
    pageNumber: firstPageIndex + 1,
    ...(lastPageIndex === firstPageIndex ? {} : { lastPageNumber: lastPageIndex + 1 }),
    ...(visibleSectionLabel === null ? {} : { sectionLabel: visibleSectionLabel }),
    contentLabel: ownedContentLabel(item.kind),
    ...presentation,
    mutable: canEditPdfAnnotationComment(item),
  };
}

export interface ExistingAnnotationReaderProjectionOptions {
  readonly documentGeneration: number;
  readonly discoveryGeneration: number;
  readonly sectionLabel?: string;
}

export function projectExistingAnnotationReader(
  annotation: ExistingAnnotation,
  options: ExistingAnnotationReaderProjectionOptions,
): ExistingAnnotationReaderRecord | null {
  const content = nonBlankString(annotation.contents);
  if (content === null) return null;

  const sectionLabel = nonBlankString(options.sectionLabel);
  const author = nonBlankString(annotation.author);
  return {
    identity: {
      origin: 'source',
      annotationKey: existingAnnotationKey(annotation),
      documentGeneration: options.documentGeneration,
      discoveryGeneration: options.discoveryGeneration,
    },
    origin: 'source',
    kind: annotation.subtype,
    typeLabel: annotationKindLabel(annotation.subtype),
    pageNumber: annotation.pageIndex + 1,
    ...(sectionLabel === null ? {} : { sectionLabel }),
    ...(author === null ? {} : { author }),
    contentLabel: 'Annotation contents',
    content,
    mutable: false,
  };
}

export interface AnnotationReaderSources {
  readonly ownedItems: readonly ReviewItem[];
  readonly existingAnnotations: ExistingAnnotationsDiscovery;
  readonly documentGeneration: number;
  readonly ownedSectionLabels?: ReadonlyMap<string, string>;
  readonly sourceSectionLabels?: ReadonlyMap<string, string>;
}

/** Resolve transient reader identity against current annotation and source authority. */
export function resolveAnnotationReader(
  identity: AnnotationReaderIdentity,
  sources: AnnotationReaderSources,
): AnnotationReaderRecord | null {
  if (identity.origin === 'owned') {
    const item = sources.ownedItems.find(({ id }) => id === identity.itemId);
    return item === undefined
      ? null
      : projectOwnedAnnotationReader(item, sources.ownedSectionLabels?.get(item.id));
  }

  if (
    identity.documentGeneration !== sources.documentGeneration
    || sources.existingAnnotations.status !== 'ready'
    || identity.discoveryGeneration !== sources.existingAnnotations.generation
  ) {
    return null;
  }

  const annotation = sources.existingAnnotations.items.find(
    (candidate) => existingAnnotationKey(candidate) === identity.annotationKey,
  );
  const sectionLabel = sources.sourceSectionLabels?.get(identity.annotationKey);
  return annotation === undefined
    ? null
    : projectExistingAnnotationReader(annotation, {
        documentGeneration: identity.documentGeneration,
        discoveryGeneration: identity.discoveryGeneration,
        ...(sectionLabel === undefined ? {} : { sectionLabel }),
      });
}

export function annotationReaderIdentityMatches(
  left: AnnotationReaderIdentity,
  right: AnnotationReaderIdentity,
): boolean {
  if (left.origin !== right.origin) return false;
  if (left.origin === 'owned' && right.origin === 'owned') return left.itemId === right.itemId;
  return left.origin === 'source'
    && right.origin === 'source'
    && left.documentGeneration === right.documentGeneration
    && left.discoveryGeneration === right.discoveryGeneration
    && left.annotationKey === right.annotationKey;
}
