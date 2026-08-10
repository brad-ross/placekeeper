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

async function waitForOpen(responseTask: PromiseTask<ReferenceOpenResponse>): Promise<void> {
  const response = await responseTask.toPromise();
  await response.task.toPromise();
}

export function createReferenceDocumentController(input: {
  readonly documentManager: ReferenceDocumentManager;
  readonly assetUrls: ViewerAssetUrls;
  readonly origin: string;
  readonly documentGeneration: number;
}): ReferenceDocumentController {
  let documentGeneration = input.documentGeneration;
  let status: ReferenceDocumentStatus = 'idle';
  let operationGeneration = 0;
  let pending: Promise<boolean> | null = null;
  let closing: Promise<void> | null = null;

  const currentSnapshot = (): ReferenceDocumentSnapshot => Object.freeze({
    documentGeneration,
    status,
  });

  const run = (kind: 'open' | 'retry'): Promise<boolean> => {
    if (pending) return pending;
    status = 'opening';
    const operation = ++operationGeneration;
    const startedGeneration = documentGeneration;
    const precedingClose = closing;
    pending = (async () => {
      if (precedingClose) await precedingClose;
      if (operation !== operationGeneration || startedGeneration !== documentGeneration) return false;
      const documentStatus = input.documentManager.getDocumentState(REFERENCE_PDF_DOCUMENT_ID)?.status;
      if (kind === 'open' && documentStatus === 'loaded') {
        status = 'loaded';
        return input.documentManager.getActiveDocumentId() === MAIN_PDF_DOCUMENT_ID;
      }
      if (kind === 'retry' && documentStatus !== 'error') return false;
      const task = kind === 'open'
        ? input.documentManager.openDocumentUrl(buildReferenceDocumentOptions(input.assetUrls, input.origin))
        : input.documentManager.retryDocument(REFERENCE_PDF_DOCUMENT_ID);
      try {
        await waitForOpen(task);
        if (operation !== operationGeneration || startedGeneration !== documentGeneration) {
          void input.documentManager.closeDocument(REFERENCE_PDF_DOCUMENT_ID).toPromise().catch(() => undefined);
          return false;
        }
        if (input.documentManager.getActiveDocumentId() !== MAIN_PDF_DOCUMENT_ID) {
          status = 'failed';
          return false;
        }
        status = 'loaded';
        return true;
      } catch {
        if (operation === operationGeneration && startedGeneration === documentGeneration) status = 'failed';
        return false;
      }
    })().finally(() => {
      if (operation === operationGeneration) pending = null;
    });
    return pending;
  };

  const close = (): Promise<void> => {
    if (closing !== null && pending === null) return closing;
    const inFlight = pending;
    const precedingClose = closing;
    operationGeneration += 1;
    pending = null;
    status = 'idle';
    const task = (async () => {
      if (precedingClose) await precedingClose;
      if (inFlight) await inFlight;
      try {
        await input.documentManager.closeDocument(REFERENCE_PDF_DOCUMENT_ID).toPromise();
      } catch {
        // Deliberately quiet: raw engine/load failures cannot enter UI state or logs here.
      }
    })();
    let lifecycle!: Promise<void>;
    lifecycle = task.finally(() => {
      if (closing === lifecycle) closing = null;
    });
    closing = lifecycle;
    return lifecycle;
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
