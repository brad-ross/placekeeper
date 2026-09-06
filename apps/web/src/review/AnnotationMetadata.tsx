import { ReviewIcon, type ReviewIconName } from './ReviewIcon.js';

export interface AnnotationMetadataProps {
  readonly kind: string;
  readonly pageNumber: number;
  readonly lastPageNumber?: number;
  readonly sectionLabel?: string;
  readonly rowHead?: boolean;
}

const ANNOTATION_KIND_LABELS: Readonly<Record<string, string>> = {
  delete: 'Delete',
  highlight: 'Highlight',
  insert: 'Insert',
  pageNote: 'Page Note',
  replace: 'Replace',
};

const ANNOTATION_KIND_ICONS: Readonly<Record<string, ReviewIconName>> = {
  delete: 'delete',
  highlight: 'highlight',
  insert: 'insert',
  pagenote: 'note',
  replace: 'replace',
  stamp: 'note',
  text: 'note',
};

export function annotationKindIcon(kind: string): ReviewIconName {
  return ANNOTATION_KIND_ICONS[kind.toLowerCase()] ?? 'annotations';
}

export function annotationKindLabel(kind: string): string {
  return ANNOTATION_KIND_LABELS[kind] ?? kind;
}

export function annotationAccessibleLabel(input: AnnotationMetadataProps & {
  readonly excerpt?: string;
}): string {
  return [
    annotationKindLabel(input.kind),
    input.lastPageNumber !== undefined && input.lastPageNumber !== input.pageNumber
      ? `Pages ${input.pageNumber}–${input.lastPageNumber}`
      : `Page ${input.pageNumber}`,
    input.sectionLabel,
    input.excerpt,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' · ');
}

export function AnnotationMetadata({ kind, pageNumber, lastPageNumber, sectionLabel, rowHead = false }: AnnotationMetadataProps) {
  const icon = annotationKindIcon(kind);
  const kindLabel = annotationKindLabel(kind);
  return (
    <span
      className="annotation-item__meta"
      data-annotation-metadata-layout={rowHead ? 'row-head' : undefined}
      aria-hidden="true"
    >
      <span
        className="annotation-item__kind-icon"
        data-annotation-kind-icon={icon}
        title={kindLabel}
      >
        <ReviewIcon name={icon} size={16} />
      </span>
      <span className="annotation-item__page">
        {lastPageNumber !== undefined && lastPageNumber !== pageNumber
          ? `${pageNumber}–${lastPageNumber}`
          : pageNumber}
      </span>
      {sectionLabel ? (
        <>
          <span className="annotation-item__separator">·</span>
          <span className="annotation-item__section" title={sectionLabel}>{sectionLabel}</span>
        </>
      ) : null}
    </span>
  );
}
