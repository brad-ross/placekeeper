import { DocumentManagerPlugin } from '@embedpdf/plugin-document-manager';
import { InteractionManagerPlugin } from '@embedpdf/plugin-interaction-manager';
import { describe, expect, it } from 'vitest';

import {
  createLocalPdfiumViewerPlugins,
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
    expect(() => validateViewerResourceUrl('vscode-webview://authority/snapshots/other.pdf', {
      host: 'vscode',
      issued,
    })).toThrow(/extension-issued/u);
    expect(() => validateViewerResourceUrl('http://127.0.0.1:43179/document.pdf', {
      host: 'vscode',
      issued,
    })).toThrow(/extension-issued/u);
  });
});
