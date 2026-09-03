import type { ReviewItem } from '../../../../packages/core/src/review-model.js';
import {
  existingAnnotationKey,
  type ExistingAnnotation,
  type ExistingAnnotationsDiscovery,
} from '../pdf/existing-annotations.js';
import { annotationKindLabel } from './AnnotationMetadata.js';
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

interface AnnotationReaderRecordBase {
  readonly identity: AnnotationReaderIdentity;
  readonly origin: 'owned' | 'source';
  readonly kind: string;
  readonly typeLabel: string;
  readonly pageNumber: number;
  readonly lastPageNumber?: number;
  readonly sectionLabel?: string;
  readonly contentLabel:
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
  readonly mutable: true;
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

function ownedAuthoredContent(item: ReviewItem): Pick<
  OwnedAnnotationReaderRecord,
  'content' | 'contentLabel'
> | null {
  switch (item.kind) {
    case 'replace': {
      const content = nonBlankString(item.payload.proposedText);
      return content === null ? null : { content, contentLabel: 'Replacement text' };
    }
    case 'insert': {
      const content = nonBlankString(item.payload.proposedText);
      return content === null ? null : { content, contentLabel: 'Insertion text' };
    }
    case 'highlight': {
      const content = nonBlankString(item.payload.comment);
      return content === null ? null : { content, contentLabel: 'Comment' };
    }
    case 'pageNote': {
      const content = nonBlankString(item.payload.comment);
      return content === null ? null : { content, contentLabel: 'Page note' };
    }
    case 'delete':
      return null;
  }
}

export function projectOwnedAnnotationReader(
  item: ReviewItem,
  sectionLabel?: string,
): OwnedAnnotationReaderRecord | null {
  const authored = ownedAuthoredContent(item);
  if (authored === null) return null;
  const visibleSectionLabel = nonBlankString(sectionLabel);
  const { firstPageIndex, lastPageIndex } = reviewItemPageRange(item);

  return {
    identity: { origin: 'owned', itemId: item.id },
    origin: 'owned',
    kind: item.kind,
    typeLabel: annotationKindLabel(item.kind),
    pageNumber: firstPageIndex + 1,
    ...(lastPageIndex === firstPageIndex ? {} : { lastPageNumber: lastPageIndex + 1 }),
    ...(visibleSectionLabel === null ? {} : { sectionLabel: visibleSectionLabel }),
    ...authored,
    mutable: true,
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
