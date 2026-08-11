import type {
  PdfBookmarkObject,
  PdfBookmarksObject,
  PdfDocumentObject,
  PdfEngine,
} from '@embedpdf/models';

import { createPdfNavigationMetadata } from './pdf-navigation-metadata.js';
import {
  classifyPdfNavigationTarget,
  type PdfNavigationTarget,
} from './pdf-navigation-target.js';

export interface PdfOutlineItem {
  readonly id: string;
  readonly label: string;
  readonly pageContext: string | null;
  readonly target: PdfNavigationTarget | null;
  readonly children: readonly PdfOutlineItem[];
}

export type PdfOutlineDiscovery =
  | { readonly status: 'loading'; readonly documentGeneration: number }
  | { readonly status: 'loaded-empty'; readonly documentGeneration: number }
  | {
    readonly status: 'loaded-tree';
    readonly documentGeneration: number;
    readonly items: readonly PdfOutlineItem[];
  }
  | { readonly status: 'unavailable'; readonly documentGeneration: number };

export interface PdfOutlineDiscoveryToken {
  readonly requestGeneration: number;
  readonly documentGeneration: number;
}

function safeOutlineLabel(value: unknown): string {
  const metadata = createPdfNavigationMetadata({ contents: value, pageIndex: 0 });
  return metadata.authorLabel ?? 'Untitled outline item';
}

function classifyBookmark(
  bookmark: PdfBookmarkObject,
  path: readonly number[],
  documentGeneration: number,
  pageCount: number,
): PdfOutlineItem {
  const classification = classifyPdfNavigationTarget(bookmark.target, {
    documentGeneration,
    pageCount,
  });
  const metadata = classification.ok
    ? createPdfNavigationMetadata({
      contents: bookmark.title,
      pageIndex: classification.target.pageIndex,
    })
    : null;
  return Object.freeze({
    id: `outline-${path.join('-')}`,
    label: metadata?.label ?? safeOutlineLabel(bookmark.title),
    pageContext: metadata?.pageContext ?? null,
    target: classification.ok ? classification.target : null,
    children: Object.freeze((bookmark.children ?? []).map((child, index) => (
      classifyBookmark(child, [...path, index], documentGeneration, pageCount)
    ))),
  });
}

export function discoverPdfOutline(input: {
  readonly bookmarks: readonly PdfBookmarkObject[];
  readonly documentGeneration: number;
  readonly pageCount: number;
}): PdfOutlineDiscovery {
  const items = input.bookmarks.map((bookmark, index) => (
    classifyBookmark(bookmark, [index], input.documentGeneration, input.pageCount)
  ));
  return items.length === 0
    ? { status: 'loaded-empty', documentGeneration: input.documentGeneration }
    : {
      status: 'loaded-tree',
      documentGeneration: input.documentGeneration,
      items: Object.freeze(items),
    };
}

export class PdfOutlineDiscoveryAuthority {
  private requestGeneration = 0;
  private current: PdfOutlineDiscoveryToken | null = null;

  begin(documentGeneration: number): PdfOutlineDiscoveryToken {
    const token = Object.freeze({
      requestGeneration: ++this.requestGeneration,
      documentGeneration,
    });
    this.current = token;
    return token;
  }

  loading(token: PdfOutlineDiscoveryToken): PdfOutlineDiscovery | null {
    return this.isCurrent(token)
      ? { status: 'loading', documentGeneration: token.documentGeneration }
      : null;
  }

  loaded(token: PdfOutlineDiscoveryToken, items: readonly PdfOutlineItem[]): PdfOutlineDiscovery | null {
    if (!this.isCurrent(token)) return null;
    return items.length === 0
      ? { status: 'loaded-empty', documentGeneration: token.documentGeneration }
      : { status: 'loaded-tree', documentGeneration: token.documentGeneration, items };
  }

  unavailable(token: PdfOutlineDiscoveryToken): PdfOutlineDiscovery | null {
    return this.isCurrent(token)
      ? { status: 'unavailable', documentGeneration: token.documentGeneration }
      : null;
  }

  invalidate(): void {
    this.requestGeneration += 1;
    this.current = null;
  }

  private isCurrent(token: PdfOutlineDiscoveryToken): boolean {
    return this.current === token && token.requestGeneration === this.requestGeneration;
  }
}

export async function readPdfOutline(input: {
  readonly engine: PdfEngine;
  readonly document: PdfDocumentObject;
  readonly documentGeneration: number;
  readonly pageCount: number;
}): Promise<PdfOutlineDiscovery> {
  const result: PdfBookmarksObject = await input.engine.getBookmarks(input.document).toPromise();
  return discoverPdfOutline({
    bookmarks: result.bookmarks,
    documentGeneration: input.documentGeneration,
    pageCount: input.pageCount,
  });
}
