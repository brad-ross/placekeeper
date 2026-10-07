import { DocumentManagerPlugin } from '@embedpdf/plugin-document-manager';
import { InteractionManagerPlugin } from '@embedpdf/plugin-interaction-manager';
import { SelectionPlugin } from '@embedpdf/plugin-selection';
import { ZoomMode, ZoomPlugin } from '@embedpdf/plugin-zoom';
import { describe, expect, it, vi } from 'vitest';

import {
  createLocalPdfiumViewerPlugins,
  createTrustedPdfiumWorker,
  buildViewerDocumentOptions,
  validateViewerResourceUrl,
} from '../src/pdf/embedpdf-viewer.js';
import { MAIN_PDF_DOCUMENT_ID } from '../src/pdf/viewer-document-ids.js';
import {
  PDF_SELECTION_GEOMETRY_CACHE_PAGE_LIMIT,
  PDF_SELECTION_PAGE_LIMIT,
  PDF_SELECTION_PAGE_LIMIT_MESSAGE,
} from '../src/pdf/selection-page-limit.js';

describe('EmbedPDF registry configuration', () => {
  it('pins one two-document registry with a stable active main document', () => {
    const plugins = createLocalPdfiumViewerPlugins({
      pdfiumWasm: '/pdfium.wasm',
      documentUrl: '/document.pdf',
      requestHeaders: { Authorization: 'Bearer memory-only' },
    }, 'http://127.0.0.1:4173');
    const registrations = plugins as Array<{
      package: { manifest: { id: string } };
      config?: Record<string, unknown>;
    }>;
    const documents = registrations.find(({ package: pluginPackage }) => (
      pluginPackage.manifest.id === DocumentManagerPlugin.id
    ));
    const interaction = registrations.find(({ package: pluginPackage }) => (
      pluginPackage.manifest.id === InteractionManagerPlugin.id
    ));
    const selection = registrations.find(({ package: pluginPackage }) => (
      pluginPackage.manifest.id === SelectionPlugin.id
    ));
    const zoom = registrations.find(({ package: pluginPackage }) => (
      pluginPackage.manifest.id === ZoomPlugin.id
    ));

    expect(documents?.config).toMatchObject({
      maxDocuments: 2,
      initialDocuments: [{
        documentId: MAIN_PDF_DOCUMENT_ID,
        autoActivate: true,
        requestOptions: {
          credentials: 'omit',
          headers: { Authorization: 'Bearer memory-only' },
        },
      }],
    });
    expect(interaction?.config).toEqual({
      exclusionRules: { dataAttributes: ['data-pdf-link-control'] },
    });
    expect(PDF_SELECTION_PAGE_LIMIT).toBe(12);
    expect(PDF_SELECTION_GEOMETRY_CACHE_PAGE_LIMIT).toBeGreaterThan(PDF_SELECTION_PAGE_LIMIT);
    expect(PDF_SELECTION_PAGE_LIMIT_MESSAGE).toContain(String(PDF_SELECTION_PAGE_LIMIT));
    expect(selection?.config).toMatchObject({
      maxCachedGeometries: PDF_SELECTION_GEOMETRY_CACHE_PAGE_LIMIT,
    });
    expect(zoom?.config).toMatchObject({
      defaultZoomLevel: ZoomMode.FitWidth,
    });
  });

  it('keeps browser resources same-origin and accepts only extension-issued webview resources', () => {
    expect(validateViewerResourceUrl('/document.pdf', {
      host: 'browser',
      origin: 'http://127.0.0.1:4173',
    })).toBe('http://127.0.0.1:4173/document.pdf');
    expect(() => validateViewerResourceUrl('https://example.com/document.pdf', {
      host: 'browser',
      origin: 'http://127.0.0.1:4173',
    })).toThrow(/same-origin/u);

    const issued = new Set([
      'vscode-webview://authority/snapshots/digest.pdf',
      'vscode-webview://authority/assets/pdfium.wasm',
    ]);
    expect(validateViewerResourceUrl('vscode-webview://authority/snapshots/digest.pdf', {
      host: 'vscode',
      issued,
    })).toBe('vscode-webview://authority/snapshots/digest.pdf');
    const desktopUri = 'https://file+.vscode-resource.vscode-cdn.net/private/digest.pdf';
    expect(validateViewerResourceUrl(desktopUri, {
      host: 'vscode',
      issued: new Set([desktopUri]),
    })).toBe(desktopUri);
    const blobUri = 'blob:vscode-webview://authority/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(validateViewerResourceUrl(blobUri, {
      host: 'vscode',
      issued: new Set([blobUri]),
    })).toBe(blobUri);
    expect(() => validateViewerResourceUrl('vscode-webview://authority/snapshots/other.pdf', {
      host: 'vscode',
      issued,
    })).toThrow(/extension-issued/u);
    expect(() => validateViewerResourceUrl('http://127.0.0.1:43179/document.pdf', {
      host: 'vscode',
      issued,
    })).toThrow(/extension-issued/u);
  });

  it('binds Chrome document, WASM, and worker URLs to their issued roles', () => {
    const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const resources = {
      document: `blob:${extensionOrigin}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      pdfiumWasm: `${extensionOrigin}/assets/pdfium.wasm`,
      worker: `${extensionOrigin}/assets/pdfium-worker.js`,
    };
    const policy = { host: 'chrome', extensionOrigin, resources } as const;

    expect(validateViewerResourceUrl(resources.document, policy, 'document')).toBe(resources.document);
    expect(validateViewerResourceUrl(resources.pdfiumWasm, policy, 'pdfium-wasm')).toBe(resources.pdfiumWasm);
    expect(validateViewerResourceUrl(resources.worker, policy, 'pdfium-worker')).toBe(resources.worker);
    expect(() => validateViewerResourceUrl(resources.worker, policy, 'pdfium-wasm')).toThrow(/role/iu);
    expect(() => validateViewerResourceUrl('https://example.com/worker.js', policy, 'pdfium-worker')).toThrow();
    expect(() => validateViewerResourceUrl('http://127.0.0.1:43179/pdfium.wasm', policy, 'pdfium-wasm')).toThrow();
    expect(() => validateViewerResourceUrl('data:text/javascript,postMessage(1)', policy, 'pdfium-worker')).toThrow();
  });

  it('binds macOS document and executable schemes to their issued roles', () => {
    const resources = {
      document: 'placekeeper-resource://document/resource_12345678?generation=1&role=document',
      pdfiumWasm: 'placekeeper-app://bundle/assets/pdfium.wasm',
      worker: 'placekeeper-app://bundle/assets/pdfium-worker.js',
    };
    const policy = { host: 'macos', resources } as const;
    expect(validateViewerResourceUrl(resources.document, policy, 'document')).toBe(resources.document);
    expect(validateViewerResourceUrl(resources.pdfiumWasm, policy, 'pdfium-wasm')).toBe(resources.pdfiumWasm);
    expect(validateViewerResourceUrl(resources.worker, policy, 'pdfium-worker')).toBe(resources.worker);
    expect(() => validateViewerResourceUrl(resources.worker, policy, 'pdfium-wasm')).toThrow(/role/iu);
    expect(() => validateViewerResourceUrl('https://example.com/pdfium.wasm', policy, 'pdfium-wasm')).toThrow();
    expect(() => validateViewerResourceUrl('placekeeper-resource://document/other?generation=1&role=document', policy, 'document')).toThrow();
  });

  it('creates the PDF engine worker only from the trusted worker role', () => {
    const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const workerUrl = `${extensionOrigin}/assets/pdfium-worker.js`;
    const worker = { postMessage() {}, addEventListener() {}, removeEventListener() {}, terminate() {} } as unknown as Worker;
    const workerFactory = vi.fn(() => worker);
    const created = createTrustedPdfiumWorker(workerUrl, {
      host: 'chrome',
      extensionOrigin,
      resources: {
        document: `blob:${extensionOrigin}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        pdfiumWasm: `${extensionOrigin}/assets/pdfium.wasm`,
        worker: workerUrl,
      },
    }, workerFactory);

    expect(created).toBe(worker);
    expect(workerFactory).toHaveBeenCalledWith(workerUrl, { type: 'module' });
  });

  it('surfaces both worker crashes and PDFium initialization failures', () => {
    const listeners = new Map<string, (event: Event | MessageEvent<unknown>) => void>();
    const worker = {
      postMessage() {},
      addEventListener(type: string, listener: (event: Event | MessageEvent<unknown>) => void) {
        listeners.set(type, listener);
      },
      removeEventListener() {},
      terminate() {},
    } as unknown as Worker;
    const onWorkerError = vi.fn();
    const workerUrl = 'blob:placekeeper-worker-resource';
    createTrustedPdfiumWorker(workerUrl, {
      host: 'macos',
      resources: {
        document: 'blob:placekeeper-document-resource',
        pdfiumWasm: 'blob:placekeeper-pdfium-resource',
        worker: workerUrl,
      },
    }, () => worker, onWorkerError);

    listeners.get('message')?.({ data: { type: 'wasmError' } } as MessageEvent<unknown>);
    listeners.get('error')?.(new Event('error'));
    expect(onWorkerError).toHaveBeenCalledTimes(2);
  });
});

it('transfers only fresh Codex WASM copies while retaining verified bytes and caller transfers', () => {
  const resources = { document: 'blob:https://native/document', pdfiumWasm: 'blob:https://native/wasm', worker: 'blob:https://native/worker' };
  const deliveries: Record<string, unknown>[] = [];
  const postMessage = vi.fn((message: Record<string, unknown>, transfer: Transferable[]) => {
    deliveries.push(structuredClone(message, { transfer }));
  });
  const wasm = new Uint8Array([0, 97, 115, 109]);
  const worker = createTrustedPdfiumWorker(resources.worker, { host: 'codex', resources }, () => ({ postMessage, addEventListener: vi.fn() }) as unknown as Worker, undefined, wasm);
  const extra = new Uint8Array([17, 23]);
  const originalTransfers = [extra.buffer];
  worker.postMessage({ type: 'wasmInit', wasmUrl: resources.pdfiumWasm, fontFallback: null, extra: extra.buffer }, originalTransfers);
  const [message, transfers] = postMessage.mock.calls[0]!;
  const sent = message.wasmBinary as ArrayBuffer;
  expect(transfers).toHaveLength(2);
  expect(transfers[0]).toBe(extra.buffer);
  expect(transfers[1]).toBe(sent);
  expect(originalTransfers).toHaveLength(1);
  expect(originalTransfers[0]).toBe(extra.buffer);
  expect(sent).not.toBe(wasm.buffer); expect(sent.byteLength).toBe(0);
  expect(extra.byteLength).toBe(0);
  expect(wasm).toEqual(new Uint8Array([0, 97, 115, 109]));
  expect(new Uint8Array(deliveries[0]!.wasmBinary as ArrayBuffer)).toEqual(wasm);
  expect(new Uint8Array(deliveries[0]!.extra as ArrayBuffer)).toEqual(new Uint8Array([17, 23]));
  worker.postMessage({ type: 'wasmInit', wasmUrl: resources.pdfiumWasm });
  expect(postMessage.mock.calls[1]![0].wasmBinary).not.toBe(sent);
  expect(new Uint8Array(deliveries[1]!.wasmBinary as ArrayBuffer)).toEqual(wasm);
  expect(wasm.byteLength).toBe(4);
  const payload = new Uint8Array([31]);
  const ordinary = { type: 'execute', payload: payload.buffer }, ordinaryTransfers = [payload.buffer];
  worker.postMessage(ordinary, ordinaryTransfers);
  expect(postMessage.mock.calls[2]![0]).toBe(ordinary);
  expect(postMessage.mock.calls[2]![1]).toBe(ordinaryTransfers);
  expect(deliveries[2]!.wasmBinary).toBeUndefined();
  expect(new Uint8Array(deliveries[2]!.payload as ArrayBuffer)).toEqual(new Uint8Array([31]));
  const missingBytesFactory = vi.fn(() => ({ postMessage }) as unknown as Worker);
  expect(() => createTrustedPdfiumWorker(resources.worker, { host: 'codex', resources }, missingBytesFactory)).toThrow('Verified native engine bytes');
  expect(missingBytesFactory).not.toHaveBeenCalled();
});

it('loads Codex PDFs from verified buffer bytes and keeps other hosts on their existing URL path', () => {
  const resources = { document: 'blob:codex-sandbox://native/document', pdfiumWasm: 'blob:codex-sandbox://native/wasm', worker: 'blob:codex-sandbox://native/worker' };
  const documentBytes = new Uint8Array([37, 80, 68, 70]);
  const assets = { documentUrl: resources.document, pdfiumWasm: resources.pdfiumWasm, documentBytes };
  const options = buildViewerDocumentOptions(assets, { host: 'codex', resources });
  expect(options).toEqual({ name: 'Local PDF', buffer: documentBytes.buffer });
  expect((options as { buffer: ArrayBuffer }).buffer).not.toBe(documentBytes.buffer);
  expect(() => buildViewerDocumentOptions({ documentUrl: assets.documentUrl, pdfiumWasm: assets.pdfiumWasm }, { host: 'codex', resources })).toThrow('Verified native document bytes');
  expect(() => buildViewerDocumentOptions({ ...assets, documentUrl: resources.worker }, { host: 'codex', resources })).toThrow(/role/iu);
  expect(buildViewerDocumentOptions(assets, { host: 'macos', resources })).toHaveProperty('url', resources.document);
});
