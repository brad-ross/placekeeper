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
import {
  VIEWER_ZOOM_MAX_PERCENT,
  VIEWER_ZOOM_MIN_PERCENT,
} from './viewer-controls.js';
import { PDF_LINK_INTERACTION_ATTRIBUTE } from './viewer-interaction-events.js';
import { MAIN_PDF_DOCUMENT_ID } from './viewer-document-ids.js';

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
  const engine = createPdfiumEngine(pdfiumWasm, { encoderPoolSize: 1, fontFallback: null });
  return { engine, plugins: createLocalPdfiumViewerPlugins(assetUrls, origin) };
}

export function createLocalPdfiumViewerPlugins(
  assetUrls: ViewerAssetUrls,
  origin: string,
): PluginBatchRegistrations {
  const document = {
    ...buildViewerDocumentOptions(assetUrls, origin),
    documentId: MAIN_PDF_DOCUMENT_ID,
    autoActivate: true,
  };
  const plugins: PluginBatchRegistrations = [
    createPluginRegistration(DocumentManagerPluginPackage, {
      maxDocuments: 2,
      initialDocuments: [document],
    }),
    createPluginRegistration(InteractionManagerPluginPackage, {
      exclusionRules: { dataAttributes: [PDF_LINK_INTERACTION_ATTRIBUTE] },
    }),
    createPluginRegistration(ViewportPluginPackage),
    createPluginRegistration(ScrollPluginPackage),
    createPluginRegistration(ZoomPluginPackage, {
      minZoom: VIEWER_ZOOM_MIN_PERCENT / 100,
      maxZoom: VIEWER_ZOOM_MAX_PERCENT / 100,
    }),
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
  return plugins;
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
