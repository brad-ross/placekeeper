import { DocumentManagerPlugin } from '@embedpdf/plugin-document-manager';
import { InteractionManagerPlugin } from '@embedpdf/plugin-interaction-manager';
import { describe, expect, it, vi } from 'vitest';

import {
  createLocalPdfiumViewerPlugins,
  createTrustedPdfiumWorker,
  validateViewerResourceUrl,
} from '../src/pdf/embedpdf-viewer.js';
import { MAIN_PDF_DOCUMENT_ID } from '../src/pdf/viewer-document-ids.js';

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
});
