import type { PdfOutlineItem } from '../pdf/pdf-outline.js';
import {
  placekeeperLocationFromPdfNavigationTarget,
  type PdfNavigationTarget,
  type PdfNavigationTargetContext,
} from '../pdf/pdf-navigation-target.js';
import type { PdfSearchResult } from '../pdf/pdf-search-model.js';
import { buildPlacekeeperCopyLink } from './CopyLinkControl.js';
import type { CopyLinkActionData, PdfDestinationCopyLink } from './copy-link-model.js';

export interface PdfTargetCopyLinkContext {
  readonly appLinkBase: string;
  readonly document: PdfNavigationTargetContext;
  readonly currentDocumentGeneration: () => number;
  readonly writeText: (link: string) => Promise<void>;
}

function generationCheckedWriter(
  expectedGeneration: number,
  input: Pick<PdfTargetCopyLinkContext, 'currentDocumentGeneration' | 'writeText'>,
): (link: string) => Promise<void> {
  return async (link) => {
    if (input.currentDocumentGeneration() !== expectedGeneration) {
      throw new Error('Copy Link target belongs to a replaced PDF');
    }
    await input.writeText(link);
  };
}

export function createPdfTargetCopyLink(
  target: PdfNavigationTarget,
  context: PdfTargetCopyLinkContext,
): PdfDestinationCopyLink | undefined {
  const location = placekeeperLocationFromPdfNavigationTarget(target, context.document);
  if (location === null) return undefined;
  return {
    precision: location.kind === 'destination' ? 'exact' : 'page',
    getLink: () => buildPlacekeeperCopyLink(context.appLinkBase, location),
    writeText: generationCheckedWriter(context.document.documentGeneration, context),
  };
}

export function createOutlineRowCopyLink(
  item: PdfOutlineItem,
  context: PdfTargetCopyLinkContext,
): PdfDestinationCopyLink | undefined {
  if (item.target === null) return undefined;
  return createPdfTargetCopyLink(item.target, context);
}

export function createSearchResultRowCopyLink(
  result: Pick<PdfSearchResult, 'pageIndex'>,
  context: PdfTargetCopyLinkContext,
): CopyLinkActionData | undefined {
  if (
    !Number.isSafeInteger(result.pageIndex)
    || result.pageIndex < 0
    || result.pageIndex >= context.document.pageCount
  ) return undefined;
  const location = { kind: 'page' as const, page: result.pageIndex + 1 };
  return {
    getLink: () => buildPlacekeeperCopyLink(context.appLinkBase, location),
    writeText: generationCheckedWriter(context.document.documentGeneration, context),
  };
}
