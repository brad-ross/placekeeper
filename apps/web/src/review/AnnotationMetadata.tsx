export interface AnnotationMetadataProps {
  readonly kind: string;
  readonly pageNumber: number;
  readonly sectionLabel?: string;
}

export function annotationAccessibleLabel(input: AnnotationMetadataProps & {
  readonly excerpt?: string;
}): string {
  return [
    input.kind,
    `Page ${input.pageNumber}`,
    input.sectionLabel,
    input.excerpt,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' · ');
}

export function AnnotationMetadata({ kind, pageNumber, sectionLabel }: AnnotationMetadataProps) {
  return (
    <span className="annotation-item__meta" aria-hidden="true">
      <strong>{kind}</strong>
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
