import { createPluginRegistration, type PluginBatchRegistrations } from '@embedpdf/core';
import { createPdfiumEngine } from '@embedpdf/engines/pdfium-worker-engine';
import { AnnotationPluginPackage, LockModeType } from '@embedpdf/plugin-annotation/react';
import { DocumentManagerPluginPackage } from '@embedpdf/plugin-document-manager/react';
import { InteractionManagerPluginPackage } from '@embedpdf/plugin-interaction-manager/react';
import { RenderPluginPackage } from '@embedpdf/plugin-render/react';
import { ScrollPluginPackage } from '@embedpdf/plugin-scroll/react';
import { SelectionPluginPackage } from '@embedpdf/plugin-selection/react';
import { ViewportPluginPackage } from '@embedpdf/plugin-viewport/react';
import { ZoomPluginPackage } from '@embedpdf/plugin-zoom/react';
import type { LoadDocumentUrlOptions } from '@embedpdf/plugin-document-manager';

export interface ViewerAssetUrls {
  pdfiumWasm: string;
  documentUrl: string;
  /** Memory-only headers, normally the U2 document-scoped Bearer credential. */
  requestHeaders?: Readonly<Record<string, string>>;
}

function sameOriginUrl(rawUrl: string, origin: string): string {
  const url = new URL(rawUrl, origin);
  if (url.origin !== origin) throw new Error('Viewer assets must be same-origin.');
  return url.href;
}

export function createLocalPdfiumViewer(assetUrls: ViewerAssetUrls, origin = globalThis.location.origin) {
  const pdfiumWasm = sameOriginUrl(assetUrls.pdfiumWasm, origin);
  const document = buildViewerDocumentOptions(assetUrls, origin);
  const engine = createPdfiumEngine(pdfiumWasm, { encoderPoolSize: 1, fontFallback: null });
  const plugins: PluginBatchRegistrations = [
    createPluginRegistration(DocumentManagerPluginPackage, {
      maxDocuments: 1,
      initialDocuments: [document],
    }),
    createPluginRegistration(InteractionManagerPluginPackage),
    createPluginRegistration(ViewportPluginPackage),
    createPluginRegistration(ScrollPluginPackage),
    createPluginRegistration(ZoomPluginPackage),
    createPluginRegistration(RenderPluginPackage),
    createPluginRegistration(SelectionPluginPackage, {
      marquee: { enabled: false },
      maxCachedGeometries: 12,
    }),
    createPluginRegistration(AnnotationPluginPackage, {
      autoCommit: false,
      autoOpenLinks: false,
      locked: { type: LockModeType.All },
    }),
  ];

  return { engine, plugins };
}

export function buildViewerDocumentOptions(
  assetUrls: ViewerAssetUrls,
  origin: string,
): LoadDocumentUrlOptions {
  return {
    url: sameOriginUrl(assetUrls.documentUrl, origin),
    name: 'Local PDF',
    mode: 'full-fetch',
    requestOptions: {
      credentials: 'omit',
      ...(assetUrls.requestHeaders === undefined
        ? {}
        : { headers: { ...assetUrls.requestHeaders } }),
    },
  };
}
