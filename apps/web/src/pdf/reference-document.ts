import type { DocumentState } from '@embedpdf/core';
import type {
  LoadDocumentUrlOptions,
} from '@embedpdf/plugin-document-manager';

import {
  buildViewerDocumentOptions,
  type ViewerAssetUrls,
} from './embedpdf-viewer.js';
import {
  MAIN_PDF_DOCUMENT_ID,
  REFERENCE_PDF_DOCUMENT_ID,
} from './viewer-document-ids.js';

interface PromiseTask<T> {
  toPromise(): Promise<T>;
}

interface ReferenceOpenResponse {
  readonly documentId: string;
  readonly task: PromiseTask<unknown>;
}

export interface ReferenceDocumentManager {
  openDocumentUrl(options: LoadDocumentUrlOptions): PromiseTask<ReferenceOpenResponse>;
  retryDocument(documentId: string): PromiseTask<ReferenceOpenResponse>;
  closeDocument(documentId: string): PromiseTask<void>;
  getActiveDocumentId(): string | null;
  getDocumentState(documentId: string): Pick<DocumentState, 'status'> | null;
}

export type ReferenceDocumentStatus = 'idle' | 'opening' | 'loaded' | 'failed';

export interface ReferenceDocumentSnapshot {
  readonly documentGeneration: number;
  readonly status: ReferenceDocumentStatus;
}

export interface ReferenceDocumentController {
  open(): Promise<boolean>;
  retry(): Promise<boolean>;
  close(): Promise<void>;
  replaceDocument(documentGeneration: number): Promise<void>;
  snapshot(): ReferenceDocumentSnapshot;
}

const DEFAULT_REFERENCE_OPEN_TIMEOUT_MS = 5_000;

export function buildReferenceDocumentOptions(
  assetUrls: ViewerAssetUrls,
  origin: string,
): LoadDocumentUrlOptions {
  return {
    ...buildViewerDocumentOptions(assetUrls, origin),
    documentId: REFERENCE_PDF_DOCUMENT_ID,
    autoActivate: false,
  };
}

function waitWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('Timed out'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (result: { readonly value: T } | { readonly error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if ('value' in result) resolve(result.value);
      else reject(result.error);
    };
    const timer = setTimeout(() => finish({ error: new Error('Timed out') }), timeoutMs);
    promise.then(
      (value) => finish({ value }),
      (error: unknown) => finish({ error }),
    );
  });
}

async function waitForOpen(
  responseTask: PromiseTask<ReferenceOpenResponse>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const response = await waitWithin(responseTask.toPromise(), deadline - Date.now());
  await waitWithin(response.task.toPromise(), deadline - Date.now());
}

export function createReferenceDocumentController(input: {
  readonly documentManager: ReferenceDocumentManager;
  readonly assetUrls: ViewerAssetUrls;
  readonly origin: string;
  readonly documentGeneration: number;
  readonly timeoutMs?: number;
}): ReferenceDocumentController {
  let documentGeneration = input.documentGeneration;
  let status: ReferenceDocumentStatus = 'idle';
  let operationGeneration = 0;
  let pending: Promise<boolean> | null = null;
  let closing: Promise<void> | null = null;
  const timeoutMs = input.timeoutMs ?? DEFAULT_REFERENCE_OPEN_TIMEOUT_MS;

  const currentSnapshot = (): ReferenceDocumentSnapshot => Object.freeze({
    documentGeneration,
    status,
  });

  const performPhysicalClose = async (): Promise<void> => {
    try {
      const closeTask = input.documentManager.closeDocument(REFERENCE_PDF_DOCUMENT_ID);
      await waitWithin(closeTask.toPromise(), timeoutMs);
    } catch {
      // Deliberately quiet: raw engine/load failures cannot enter UI state or logs here.
    }
  };

  const trackPhysicalClose = (task: Promise<void>): Promise<void> => {
    let lifecycle!: Promise<void>;
    lifecycle = task.finally(() => {
      if (closing === lifecycle) closing = null;
    });
    closing = lifecycle;
    return lifecycle;
  };

  const startPhysicalClose = (): Promise<void> => (
    closing ?? trackPhysicalClose(performPhysicalClose())
  );

  const run = (kind: 'open' | 'retry'): Promise<boolean> => {
    if (pending) return pending;
    status = 'opening';
    const operation = ++operationGeneration;
    const startedGeneration = documentGeneration;
    const precedingClose = closing;
    pending = (async () => {
      try {
        if (precedingClose) await waitWithin(precedingClose, timeoutMs);
        if (operation !== operationGeneration || startedGeneration !== documentGeneration) return false;
        const documentStatus = input.documentManager.getDocumentState(REFERENCE_PDF_DOCUMENT_ID)?.status;
        if (documentStatus === 'loaded') {
          if (input.documentManager.getActiveDocumentId() !== MAIN_PDF_DOCUMENT_ID) {
            status = 'failed';
            void startPhysicalClose();
            return false;
          }
          status = 'loaded';
          return true;
        }
        const task = kind === 'retry' && documentStatus === 'error'
          ? input.documentManager.retryDocument(REFERENCE_PDF_DOCUMENT_ID)
          : input.documentManager.openDocumentUrl(buildReferenceDocumentOptions(input.assetUrls, input.origin));
        await waitForOpen(task, timeoutMs);
        if (operation !== operationGeneration || startedGeneration !== documentGeneration) return false;
        if (input.documentManager.getActiveDocumentId() !== MAIN_PDF_DOCUMENT_ID) {
          status = 'failed';
          void startPhysicalClose();
          return false;
        }
        status = 'loaded';
        return true;
      } catch {
        if (operation === operationGeneration && startedGeneration === documentGeneration) {
          status = 'failed';
          void startPhysicalClose();
        }
        return false;
      }
    })().finally(() => {
      if (operation === operationGeneration) pending = null;
    });
    return pending;
  };

  const close = (): Promise<void> => {
    const inFlight = pending;
    operationGeneration += 1;
    pending = null;
    status = 'idle';
    if (closing !== null) return closing;
    const task = (async () => {
      if (inFlight) await inFlight;
      await performPhysicalClose();
    })();
    return trackPhysicalClose(task);
  };

  return {
    open: () => run('open'),
    retry: () => run('retry'),
    close,
    async replaceDocument(nextDocumentGeneration) {
      if (!Number.isSafeInteger(nextDocumentGeneration) || nextDocumentGeneration < 0) return;
      if (nextDocumentGeneration === documentGeneration) return;
      documentGeneration = nextDocumentGeneration;
      await close();
    },
    snapshot: currentSnapshot,
  };
}
