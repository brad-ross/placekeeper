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
import { PDF_SELECTION_GEOMETRY_CACHE_PAGE_LIMIT } from './selection-page-limit.js';

export interface ViewerAssetUrls {
  pdfiumWasm: string;
  documentUrl: string;
  /** Optional packaged single-file worker fetched and launched as a blob by the host runtime. */
  workerUrl?: string;
  /** Memory-only headers, normally the U2 document-scoped Bearer credential. */
  requestHeaders?: Readonly<Record<string, string>>;
}

export type ViewerResourcePolicy =
  | { readonly host: 'browser'; readonly origin: string }
  | { readonly host: 'vscode'; readonly issued: ReadonlySet<string> };

export function validateViewerResourceUrl(rawUrl: string, policy: ViewerResourcePolicy): string {
  if (policy.host === 'vscode') {
    const extensionResource = rawUrl.startsWith('vscode-webview://') ||
      /^https:\/\/[^/\s]+\.vscode-cdn\.net(?:\/|$)/u.test(rawUrl) ||
      /^blob:vscode-webview:\/\/[A-Za-z0-9._~-]+\/[0-9a-f-]{36}$/iu.test(rawUrl);
    if (!policy.issued.has(rawUrl) || !extensionResource) {
      throw new Error('Viewer resources must be extension-issued.');
    }
    return rawUrl;
  }
  const origin = policy.origin;
  const url = new URL(rawUrl, origin);
  if (url.origin !== origin) throw new Error('Viewer assets must be same-origin.');
  return url.href;
}

function browserPolicy(origin: string): ViewerResourcePolicy {
  return { host: 'browser', origin };
}

export function createLocalPdfiumViewer(
  assetUrls: ViewerAssetUrls,
  policy: ViewerResourcePolicy = browserPolicy(globalThis.location.origin),
) {
  const pdfiumWasm = validateViewerResourceUrl(assetUrls.pdfiumWasm, policy);
  const engine = createPdfiumEngine(pdfiumWasm, { encoderPoolSize: 1, fontFallback: null });
  return { engine, plugins: createLocalPdfiumViewerPlugins(assetUrls, policy) };
}

export function createLocalPdfiumViewerPlugins(
  assetUrls: ViewerAssetUrls,
  policyOrOrigin: ViewerResourcePolicy | string,
): PluginBatchRegistrations {
  const policy = typeof policyOrOrigin === 'string' ? browserPolicy(policyOrOrigin) : policyOrOrigin;
  const document = {
    ...buildViewerDocumentOptions(assetUrls, policy),
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
      maxCachedGeometries: PDF_SELECTION_GEOMETRY_CACHE_PAGE_LIMIT,
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
  policyOrOrigin: ViewerResourcePolicy | string,
): LoadDocumentUrlOptions {
  const policy = typeof policyOrOrigin === 'string' ? browserPolicy(policyOrOrigin) : policyOrOrigin;
  return {
    url: validateViewerResourceUrl(assetUrls.documentUrl, policy),
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
