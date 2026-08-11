import { DocumentManagerPlugin } from '@embedpdf/plugin-document-manager';
import { InteractionManagerPlugin } from '@embedpdf/plugin-interaction-manager';
import { describe, expect, it } from 'vitest';

import { createLocalPdfiumViewerPlugins } from '../src/pdf/embedpdf-viewer.js';
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
});
