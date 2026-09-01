import { ReviewIcon, type ReviewIconName } from './ReviewIcon.js';

export interface AnnotationMetadataProps {
  readonly kind: string;
  readonly pageNumber: number;
  readonly sectionLabel?: string;
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
  return ANNOTATION_KIND_ICONS[kind.toLocaleLowerCase()] ?? 'annotations';
}

export function annotationKindLabel(kind: string): string {
  return ANNOTATION_KIND_LABELS[kind] ?? kind;
}

export function annotationAccessibleLabel(input: AnnotationMetadataProps & {
  readonly excerpt?: string;
}): string {
  return [
    annotationKindLabel(input.kind),
    `Page ${input.pageNumber}`,
    input.sectionLabel,
    input.excerpt,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' · ');
}

export function AnnotationMetadata({ kind, pageNumber, sectionLabel }: AnnotationMetadataProps) {
  const icon = annotationKindIcon(kind);
  return (
    <span className="annotation-item__meta" aria-hidden="true">
      <span className="annotation-item__kind-icon" data-annotation-kind-icon={icon}>
        <ReviewIcon name={icon} size={13} />
      </span>
      <strong>{annotationKindLabel(kind)}</strong>
      <span className="annotation-item__separator">·</span>
      <span className="annotation-item__page">{pageNumber}</span>
      {sectionLabel ? (
        <>
          <span className="annotation-item__separator">·</span>
          <span className="annotation-item__section" title={sectionLabel}>{sectionLabel}</span>
        </>
      ) : null}
    </span>
  );
}
