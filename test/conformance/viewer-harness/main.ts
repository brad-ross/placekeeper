/// <reference types="vite/client" />

import { createPdfiumEngine } from '@embedpdf/engines/pdfium-worker-engine';

type ViewerInspection = {
  pageCount: number;
  text: string;
  reliableTextGeometry: boolean;
  annotationSubtypes: string[];
  renderedWidth: number;
  activeContentExecuted: boolean;
  remoteRequests: string[];
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
    9: 'highlight',
    12: 'strikeOut',
    13: 'stamp',
    14: 'caret',
  };
  return names[type] ?? `unsupported-${type}`;
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
    const [textRects, annotations, rendered] = await Promise.all([
      Promise.all(
        document.pages.map((page) => engine.getPageTextRects(document, page).toPromise()),
      ),
      Promise.all(
        document.pages.map((page) => engine.getPageAnnotations(document, page).toPromise()),
      ),
      withTimeout(engine.renderPage(document, document.pages[0]!).toPromise(), timeoutMs),
    ]);

    const normalizedText = text.trim();
    const reliableTextGeometry =
      normalizedText.length > 0 && textRects.flat().length > 0;

    return {
      pageCount: document.pageCount,
      text: reliableTextGeometry ? normalizedText : '',
      reliableTextGeometry,
      annotationSubtypes: annotations.flat().map(({ type }) => subtypeName(type)),
      renderedWidth: rendered.size,
      activeContentExecuted:
        (globalThis as typeof globalThis & { __pdfActionExecuted?: boolean })
          .__pdfActionExecuted === true,
      remoteRequests: [...remoteRequests],
    };
  } finally {
    await engine.closeDocument(document).toPromise();
  }
}

globalThis.viewerGate = { inspect };

declare global {
  var viewerGate: { inspect: typeof inspect };
}
