/** The number of annotations in the list, shown in the workspace header's right corner. */
export function AnnotationCountBadge({ count }: { readonly count: number }) {
  if (count <= 0) return null;
  return (
    <span className="review-workspace__annotation-count" data-annotation-count={count}>
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{count === 1 ? '1 annotation' : `${count} annotations`}</span>
    </span>
  );
}
