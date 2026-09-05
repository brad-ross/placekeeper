import {
  anchorEvidenceFromReviewItem,
  normalizeReviewSelectionAnchor,
  type ReviewItem,
} from '../../../../packages/core/src/review-model.js';
import { existingAnnotationKey, type ExistingAnnotation } from '../pdf/existing-annotations.js';
import {
  createPdfAnnotationOrderLocation,
  createPdfOutlineTargetOrderLocation,
  type PdfDocumentOrderPage,
  type PdfOutlineTargetOrderLocation,
} from '../pdf/document-order-location.js';
import type { PdfOutlineDiscovery } from '../pdf/pdf-outline.js';
import type { PdfNavigationTarget } from '../pdf/pdf-navigation-target.js';
import {
  createOutlineContainmentResolver,
  type OutlineContainmentResolver,
} from './navigation-coordinator.js';

export interface AnnotationOutlineLabels {
  readonly owned: ReadonlyMap<string, string>;
  readonly source: ReadonlyMap<string, string>;
}

export function canDeriveAnnotationOutlineLabels(input: {
  readonly sourceIdentity: string;
  readonly activeSourceIdentity: string;
  readonly navigationGeneration: number | null;
  readonly outlineGeneration: number;
}): input is typeof input & { readonly navigationGeneration: number } {
  return input.sourceIdentity === input.activeSourceIdentity
    && input.navigationGeneration === input.outlineGeneration;
}

export function reviewItemNavigationTarget(item: ReviewItem): {
  readonly pageIndex: number;
  readonly point: { readonly x: number; readonly y: number };
} | null {
  try {
    const anchor = anchorEvidenceFromReviewItem(item);
    const page = anchor.kind === 'selection'
      ? normalizeReviewSelectionAnchor(anchor).pages[0]
      : undefined;
    const pageIndex = page?.pageIndex ?? anchor.pageIndex;
    const rect = page?.rect ?? anchor.rect;
    return { pageIndex, point: { x: rect.x, y: rect.y } };
  } catch {
    return null;
  }
}

function annotationLabel(input: {
  readonly pageIndex: number;
  readonly point: { readonly x: number; readonly y: number };
  readonly pages: readonly PdfDocumentOrderPage[];
  readonly resolveOutlineItem: OutlineContainmentResolver;
}): string | null {
  const page = input.pages[input.pageIndex];
  if (!page) return null;
  const currentLocation = createPdfAnnotationOrderLocation({
    pageIndex: input.pageIndex,
    point: input.point,
  }, {
    page: page.size,
  });
  if (currentLocation === null) return null;
  return input.resolveOutlineItem(currentLocation)?.label ?? null;
}

export function deriveAnnotationOutlineLabels(input: {
  readonly documentGeneration: number;
  readonly outline: PdfOutlineDiscovery;
  readonly pages: readonly PdfDocumentOrderPage[];
  readonly owned: readonly ReviewItem[];
  readonly source: readonly ExistingAnnotation[];
}): AnnotationOutlineLabels {
  const owned = new Map<string, string>();
  const source = new Map<string, string>();
  if (
    input.outline.status !== 'loaded-tree'
    || input.outline.documentGeneration !== input.documentGeneration
  ) return { owned, source };
  const targetLocations = new Map<string, PdfOutlineTargetOrderLocation | null>();
  const resolveTarget = (target: PdfNavigationTarget): PdfOutlineTargetOrderLocation | null => {
    const cached = targetLocations.get(target.identity);
    if (cached !== undefined || targetLocations.has(target.identity)) return cached ?? null;
    const targetPage = input.pages[target.pageIndex];
    const location = targetPage
      ? createPdfOutlineTargetOrderLocation(target, {
        documentGeneration: input.documentGeneration,
        page: {
          ...targetPage.size,
          cropOrigin: { x: targetPage.crop.left, y: targetPage.crop.bottom },
        },
      })
      : null;
    targetLocations.set(target.identity, location);
    return location;
  };
  const resolveOutlineItem = createOutlineContainmentResolver({
    discovery: input.outline,
    resolveTarget,
  });
  for (const item of input.owned) {
    const target = reviewItemNavigationTarget(item);
    if (target === null) continue;
    const label = annotationLabel({
      ...target,
      pages: input.pages,
      resolveOutlineItem,
    });
    if (label) owned.set(item.id, label);
  }
  for (const annotation of input.source) {
    const label = annotationLabel({
      pageIndex: annotation.pageIndex,
      point: { x: annotation.rect.x, y: annotation.rect.y },
      pages: input.pages,
      resolveOutlineItem,
    });
    if (label) source.set(existingAnnotationKey(annotation), label);
  }
  return { owned, source };
}
