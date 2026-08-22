/// <reference types="vite/client" />

import { createPdfiumEngine } from '@embedpdf/engines/pdfium-worker-engine';
import {
  PdfActionType,
  PdfAnnotationSubtype,
  PdfZoomMode,
  type PdfBookmarkObject,
  type PdfDestinationObject,
  type PdfLinkTarget,
} from '@embedpdf/models';

type NavigationTargetInspection = {
  kind: 'destination' | 'goto' | 'remote-goto' | 'uri' | 'launch' | 'unsupported' | 'missing';
  pageIndex?: number;
  zoomMode?: number;
  params?: number[];
};

type NavigationLinkInspection = {
  pageIndex: number;
  contents: string;
  subject: string;
  target: NavigationTargetInspection;
};

type BookmarkInspection = {
  title: string;
  depth: number;
  target: NavigationTargetInspection;
};

type ViewerInspection = {
  pageCount: number;
  text: string;
  textRectContents: string[];
  reliableTextGeometry: boolean;
  annotationSubtypes: string[];
  renderedWidth: number;
  activeContentExecuted: boolean;
  remoteRequests: string[];
  navigationLinks: NavigationLinkInspection[];
  bookmarks: BookmarkInspection[];
};

const remoteRequests: string[] = [];
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  const url = new URL(rawUrl, globalThis.location.href);
  if (url.origin !== globalThis.location.origin && url.protocol !== 'blob:') {
    remoteRequests.push(url.href);
  }
  return originalFetch(input, init);
};

const engine = createPdfiumEngine(
  new URL('/test/fixtures/pdfium/pdfium.wasm', globalThis.location.origin).href,
  {
    encoderPoolSize: 1,
    fontFallback: null,
  },
);

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      globalThis.setTimeout(() => reject(new Error(`viewer timeout after ${timeoutMs} ms`)), timeoutMs);
    }),
  ]);
}

function subtypeName(type: number): string {
  const names: Record<number, string> = {
    1: 'text',
    2: 'link',
    9: 'highlight',
    12: 'strikeOut',
    13: 'stamp',
    14: 'caret',
  };
  return names[type] ?? `unsupported-${type}`;
}

function destinationInspection(
  kind: 'destination' | 'goto' | 'remote-goto',
  destination: PdfDestinationObject,
): NavigationTargetInspection {
  const params = destination.zoom.mode === PdfZoomMode.XYZ
    ? [destination.zoom.params.x, destination.zoom.params.y, destination.zoom.params.zoom]
    : [...destination.view];
  return {
    kind,
    pageIndex: destination.pageIndex,
    zoomMode: destination.zoom.mode,
    params,
  };
}

function targetInspection(target: PdfLinkTarget | undefined): NavigationTargetInspection {
  if (!target) return { kind: 'missing' };
  if (target.type === 'destination') {
    return destinationInspection('destination', target.destination);
  }
  switch (target.action.type) {
    case PdfActionType.Goto:
      return destinationInspection('goto', target.action.destination);
    case PdfActionType.RemoteGoto:
      return destinationInspection('remote-goto', target.action.destination);
    case PdfActionType.URI:
      return { kind: 'uri' };
    case PdfActionType.LaunchAppOrOpenFile:
      return { kind: 'launch' };
    case PdfActionType.Unsupported:
    default:
      return { kind: 'unsupported' };
  }
}

function flattenBookmarks(
  bookmarks: readonly PdfBookmarkObject[],
  depth = 0,
): BookmarkInspection[] {
  return bookmarks.flatMap((bookmark) => [
    { title: bookmark.title, depth, target: targetInspection(bookmark.target) },
    ...flattenBookmarks(bookmark.children ?? [], depth + 1),
  ]);
}

async function inspect(url: string, timeoutMs = 10_000): Promise<ViewerInspection> {
  const resolved = new URL(url, globalThis.location.href);
  if (resolved.origin !== globalThis.location.origin) {
    throw new Error('Viewer gate accepts same-origin fixture URLs only.');
  }

  const response = await withTimeout(originalFetch(resolved), timeoutMs);
  if (!response.ok) throw new Error(`fixture fetch failed: ${response.status}`);
  const content = await response.arrayBuffer();
  const document = await withTimeout(
    engine
      .openDocumentBuffer({ id: crypto.randomUUID(), content })
      .toPromise()
      .catch((error: unknown) => {
        throw new Error(`invalid PDF open: ${String(error)}`);
      }),
    timeoutMs,
  );

  try {
    const pageIndexes = document.pages.map(({ index }) => index);
    const text = await withTimeout(engine.extractText(document, pageIndexes).toPromise(), timeoutMs);
    const [textRects, annotations, rendered, bookmarks] = await Promise.all([
      Promise.all(
        document.pages.map((page) => engine.getPageTextRects(document, page).toPromise()),
      ),
      Promise.all(
        document.pages.map((page) => engine.getPageAnnotations(document, page).toPromise()),
      ),
      withTimeout(engine.renderPage(document, document.pages[0]!).toPromise(), timeoutMs),
      withTimeout(engine.getBookmarks(document).toPromise(), timeoutMs),
    ]);

    const normalizedText = text.trim();
    const reliableTextGeometry =
      normalizedText.length > 0 && textRects.flat().length > 0;

    return {
      pageCount: document.pageCount,
      text: reliableTextGeometry ? normalizedText : '',
      textRectContents: textRects.flat().map(({ content }) => content),
      reliableTextGeometry,
      annotationSubtypes: annotations.flat().map(({ type }) => subtypeName(type)),
      renderedWidth: rendered.size,
      activeContentExecuted:
        (globalThis as typeof globalThis & { __pdfActionExecuted?: boolean })
          .__pdfActionExecuted === true,
      remoteRequests: [...remoteRequests],
      navigationLinks: annotations.flat().flatMap((annotation) =>
        annotation.type === PdfAnnotationSubtype.LINK
          ? [{
              pageIndex: annotation.pageIndex,
              contents: annotation.contents ?? '',
              subject: annotation.subject ?? '',
              target: targetInspection(annotation.target),
            }]
          : []
      ),
      bookmarks: flattenBookmarks(bookmarks.bookmarks),
    };
  } finally {
    await engine.closeDocument(document).toPromise();
  }
}

globalThis.viewerGate = { inspect };

declare global {
  var viewerGate: { inspect: typeof inspect };
}
