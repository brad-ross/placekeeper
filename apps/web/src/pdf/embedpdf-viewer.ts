import { createPluginRegistration, type PluginBatchRegistrations } from '@embedpdf/core';
import { createPdfiumEngine } from '@embedpdf/engines/pdfium-worker-engine';
import { AnnotationPluginPackage, LockModeType } from '@embedpdf/plugin-annotation/react';
import { DocumentManagerPluginPackage } from '@embedpdf/plugin-document-manager/react';
import { InteractionManagerPluginPackage } from '@embedpdf/plugin-interaction-manager/react';
import { RenderPluginPackage } from '@embedpdf/plugin-render/react';
import { ScrollPluginPackage } from '@embedpdf/plugin-scroll/react';
import { SelectionPluginPackage } from '@embedpdf/plugin-selection/react';
import { ViewportPluginPackage } from '@embedpdf/plugin-viewport/react';
import { ZoomMode } from '@embedpdf/plugin-zoom';
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
  /** Optional packaged single-file worker fetched and launched as a blob by the host runtime. */
  workerUrl?: string;
  /** Memory-only headers, normally the U2 document-scoped Bearer credential. */
  requestHeaders?: Readonly<Record<string, string>>;
}

export type ViewerResourceRole = 'document' | 'pdfium-wasm' | 'pdfium-worker';

export type ViewerResourcePolicy =
  | { readonly host: 'browser'; readonly origin: string }
  | { readonly host: 'vscode'; readonly issued: ReadonlySet<string> }
  | {
      readonly host: 'chrome';
      readonly extensionOrigin: string;
      readonly resources: {
        readonly document: string;
        readonly pdfiumWasm: string;
        readonly worker: string;
      };
    }
  | {
      readonly host: 'macos';
      readonly resources: {
        readonly document: string;
        readonly pdfiumWasm: string;
        readonly worker: string;
      };
    };

export function validateViewerResourceUrl(
  rawUrl: string,
  policy: ViewerResourcePolicy,
  role: ViewerResourceRole = 'document',
): string {
  if (policy.host === 'vscode') {
    const extensionResource = rawUrl.startsWith('vscode-webview://') ||
      /^https:\/\/[^/\s]+\.vscode-cdn\.net(?:\/|$)/u.test(rawUrl) ||
      /^blob:vscode-webview:\/\/[A-Za-z0-9._~-]+\/[0-9a-f-]{36}$/iu.test(rawUrl);
    if (!policy.issued.has(rawUrl) || !extensionResource) {
      throw new Error('Viewer resources must be extension-issued.');
    }
    return rawUrl;
  }
  if (policy.host === 'chrome') {
    if (!/^chrome-extension:\/\/[a-p]{32}$/u.test(policy.extensionOrigin)) {
      throw new Error('A valid Chrome extension origin is required.');
    }
    const expected = role === 'document'
      ? policy.resources.document
      : role === 'pdfium-wasm' ? policy.resources.pdfiumWasm : policy.resources.worker;
    if (rawUrl !== expected) throw new Error('Viewer resources must match their issued role.');
    const url = new URL(rawUrl);
    if (role === 'document') {
      if (url.protocol !== 'blob:' || !rawUrl.startsWith(`blob:${policy.extensionOrigin}/`)) {
        throw new Error('The Chrome document resource must be an extension-issued Blob.');
      }
    } else if (url.protocol !== 'chrome-extension:' || !rawUrl.startsWith(`${policy.extensionOrigin}/`)) {
      throw new Error('Chrome executable resources must be packaged extension assets.');
    }
    return rawUrl;
  }
  if (policy.host === 'macos') {
    const expected = role === 'document'
      ? policy.resources.document
      : role === 'pdfium-wasm' ? policy.resources.pdfiumWasm : policy.resources.worker;
    if (rawUrl !== expected) throw new Error('Viewer resources must match their issued role.');
    const url = new URL(rawUrl);
    if (role === 'document') {
      const issuedScheme = url.protocol === 'placekeeper-resource:' && url.hostname === 'document';
      if (!issuedScheme && url.protocol !== 'blob:') {
        throw new Error('The macOS document resource must be issued by its window.');
      }
    } else if (role === 'pdfium-wasm') {
      const packagedScheme = url.protocol === 'placekeeper-app:' && url.hostname === 'bundle';
      if (!packagedScheme && url.protocol !== 'blob:') {
        throw new Error('The macOS PDF engine must be a packaged asset.');
      }
    } else if (url.protocol !== 'blob:' &&
      (url.protocol !== 'placekeeper-app:' || url.hostname !== 'bundle')) {
      throw new Error('The macOS worker must be a packaged asset.');
    }
    return rawUrl;
  }
  const origin = policy.origin;
  const url = new URL(rawUrl, origin);
  if (url.origin !== origin) throw new Error('Viewer assets must be same-origin.');
  return url.href;
}

export type ViewerWorkerFactory = (url: string, options: WorkerOptions) => Worker;

export function createTrustedPdfiumWorker(
  workerUrl: string,
  policy: ViewerResourcePolicy,
  workerFactory: ViewerWorkerFactory = (url, options) => new Worker(url, options),
  onWorkerError?: () => void,
): Worker {
  const trustedUrl = validateViewerResourceUrl(workerUrl, policy, 'pdfium-worker');
  const worker = workerFactory(trustedUrl, { type: 'module' });
  if (onWorkerError !== undefined) {
    worker.addEventListener('error', onWorkerError, { once: true });
    worker.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (typeof event.data === 'object' && event.data !== null &&
        (event.data as { readonly type?: unknown }).type === 'wasmError') onWorkerError();
    });
  }
  return worker;
}

function browserPolicy(origin: string): ViewerResourcePolicy {
  return { host: 'browser', origin };
}

export function createLocalPdfiumViewer(
  assetUrls: ViewerAssetUrls,
  policy: ViewerResourcePolicy = browserPolicy(globalThis.location.origin),
  workerFactory?: ViewerWorkerFactory,
  onWorkerError?: () => void,
) {
  const pdfiumWasm = validateViewerResourceUrl(assetUrls.pdfiumWasm, policy, 'pdfium-wasm');
  const worker = assetUrls.workerUrl === undefined
    ? undefined
    : createTrustedPdfiumWorker(assetUrls.workerUrl, policy, workerFactory, onWorkerError);
  const engine = createPdfiumEngine(pdfiumWasm, {
    encoderPoolSize: 1,
    fontFallback: null,
    ...(worker === undefined ? {} : { worker }),
  });
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
      defaultZoomLevel: ZoomMode.FitWidth,
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
  policyOrOrigin: ViewerResourcePolicy | string,
): LoadDocumentUrlOptions {
  const policy = typeof policyOrOrigin === 'string' ? browserPolicy(policyOrOrigin) : policyOrOrigin;
  return {
    url: validateViewerResourceUrl(assetUrls.documentUrl, policy, 'document'),
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
