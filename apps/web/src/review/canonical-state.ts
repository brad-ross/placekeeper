
export function firstUnresolvedReviewItemId(
  items: readonly {
    readonly id: string;
    readonly reconciliation?: { readonly disposition: { readonly kind: string } };
  }[],
): string | undefined {
  return items.find((item) =>
    item.reconciliation !== undefined && item.reconciliation.disposition.kind !== "resolved"
  )?.id;
}

export function canonicalStateSupersedes(
  current: { readonly revision: number; readonly workflow: {
    readonly documentGeneration: number;
    readonly freshness: "current" | "possibly-stale";
  } },
  canonical: { readonly revision: number; readonly workflow: {
    readonly documentGeneration: number;
    readonly freshness: "current" | "possibly-stale";
  } },
): boolean {
  return canonical.workflow.documentGeneration > current.workflow.documentGeneration ||
    canonical.workflow.documentGeneration === current.workflow.documentGeneration && (
      canonical.revision > current.revision ||
      canonical.revision === current.revision &&
        canonical.workflow.freshness === "possibly-stale" &&
        current.workflow.freshness === "current"
    );
}
