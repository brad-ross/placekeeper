import type { LoadDocumentUrlOptions } from '@embedpdf/plugin-document-manager';
import { describe, expect, it, vi } from 'vitest';

import {
  buildReferenceDocumentOptions,
  createReferenceDocumentController,
} from '../src/pdf/reference-document.js';
import {
  MAIN_PDF_DOCUMENT_ID,
  REFERENCE_PDF_DOCUMENT_ID,
} from '../src/pdf/viewer-document-ids.js';

function resolvedTask<T>(value: T) {
  return { toPromise: () => Promise.resolve(value) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('reference document scope', () => {
  it.each([
    'https://file.vscode-cdn.net/review/document.pdf',
    'vscode-webview://review/document.pdf',
    'blob:vscode-webview://review/12345678-1234-1234-1234-123456789abc',
  ])('opens issued reference %s using the host policy and rejects unissued resources', async (documentUrl) => {
    const openDocumentUrl = vi.fn((options: LoadDocumentUrlOptions) => resolvedTask({
      documentId: options.documentId!, task: resolvedTask(undefined),
    }));
    const issued = new Set([documentUrl]);
    const controller = createReferenceDocumentController({
      documentManager: {
        openDocumentUrl, retryDocument: vi.fn(), closeDocument: vi.fn(() => resolvedTask(undefined)),
        getActiveDocumentId: () => MAIN_PDF_DOCUMENT_ID,
        getDocumentState: () => null,
      },
      assetUrls: { pdfiumWasm: 'https://file.vscode-cdn.net/pdfium.wasm', documentUrl },
      origin: 'vscode-webview://review',
      resourcePolicy: { host: 'vscode', issued },
      documentGeneration: 1,
    });
    expect(await controller.open()).toBe(true);
    expect(openDocumentUrl).toHaveBeenCalledWith(expect.objectContaining({
      url: documentUrl, documentId: REFERENCE_PDF_DOCUMENT_ID, autoActivate: false,
    }));
    await controller.close();
    issued.clear();
    expect(await controller.open()).toBe(false);
    expect(openDocumentUrl).toHaveBeenCalledOnce();
  });

  it('opens once with a fresh safe non-active clone and retries the stable failed id', async () => {
    let failed = false;
    const loadTask = resolvedTask({ id: REFERENCE_PDF_DOCUMENT_ID });
    const openDocumentUrl = vi.fn((options: LoadDocumentUrlOptions) => resolvedTask({
      documentId: options.documentId!, task: loadTask,
    }));
    const retryDocument = vi.fn(() => resolvedTask({
      documentId: REFERENCE_PDF_DOCUMENT_ID, task: loadTask,
    }));
    const closeDocument = vi.fn(() => resolvedTask(undefined));
    const getActiveDocumentId = vi.fn(() => MAIN_PDF_DOCUMENT_ID);
    const controller = createReferenceDocumentController({
      documentManager: {
        openDocumentUrl, retryDocument, closeDocument, getActiveDocumentId,
        getDocumentState: () => failed ? { status: 'error' } : null,
      },
      assetUrls: {
        pdfiumWasm: '/pdfium.wasm', documentUrl: '/document.pdf',
        requestHeaders: { Authorization: 'Bearer memory-only-secret' },
      },
      origin: 'http://127.0.0.1:4173',
      documentGeneration: 9,
    });

    const [first, repeated] = await Promise.all([controller.open(), controller.open()]);
    expect(first).toBe(true);
    expect(repeated).toBe(true);
    expect(openDocumentUrl).toHaveBeenCalledOnce();
    const options = openDocumentUrl.mock.calls[0]![0];
    expect(options).toMatchObject({
      url: 'http://127.0.0.1:4173/document.pdf',
      documentId: REFERENCE_PDF_DOCUMENT_ID,
      autoActivate: false,
      requestOptions: {
        credentials: 'omit', headers: { Authorization: 'Bearer memory-only-secret' },
      },
    });
    const fresh = buildReferenceDocumentOptions({
      pdfiumWasm: '/pdfium.wasm', documentUrl: '/document.pdf',
      requestHeaders: { Authorization: 'Bearer memory-only-secret' },
    }, 'http://127.0.0.1:4173');
    expect(options).not.toBe(fresh);
    expect(options.requestOptions?.headers).not.toBe(fresh.requestOptions?.headers);
    expect(getActiveDocumentId()).toBe(MAIN_PDF_DOCUMENT_ID);

    failed = true;
    expect(await controller.retry()).toBe(true);
    expect(retryDocument).toHaveBeenCalledWith(REFERENCE_PDF_DOCUMENT_ID);
    await controller.close();
    expect(closeDocument).toHaveBeenCalledWith(REFERENCE_PDF_DOCUMENT_ID);
  });

  it('invalidates stale in-flight opens without exposing raw failures', async () => {
    let resolveLoad: ((document: { id: string }) => void) | undefined;
    const loading = new Promise<{ id: string }>((resolve) => { resolveLoad = resolve; });
    const closeDocument = vi.fn(() => resolvedTask(undefined));
    const controller = createReferenceDocumentController({
      documentManager: {
        openDocumentUrl: vi.fn(() => resolvedTask({
          documentId: REFERENCE_PDF_DOCUMENT_ID,
          task: { toPromise: () => loading },
        })),
        retryDocument: vi.fn(), closeDocument,
        getActiveDocumentId: () => MAIN_PDF_DOCUMENT_ID,
        getDocumentState: () => ({ status: 'loading' }),
      },
      assetUrls: { pdfiumWasm: '/pdfium.wasm', documentUrl: '/document.pdf' },
      origin: 'http://127.0.0.1:4173', documentGeneration: 1,
    });

    const open = controller.open();
    const reset = controller.replaceDocument(2);
    resolveLoad?.({ id: REFERENCE_PDF_DOCUMENT_ID });
    expect(await open).toBe(false);
    await reset;
    expect(closeDocument).toHaveBeenCalledWith(REFERENCE_PDF_DOCUMENT_ID);
    expect(closeDocument).toHaveBeenCalledOnce();
    expect(JSON.stringify(controller.snapshot())).not.toMatch(/credentials|requestOptions|error|secret/iu);
  });

  it('bounds stalled opens, catches synchronous task creation, and exposes retryable failure', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<unknown>(() => undefined);
      const closeDocument = vi.fn(() => resolvedTask(undefined));
      const openDocumentUrl = vi.fn()
        .mockReturnValueOnce(resolvedTask({
          documentId: REFERENCE_PDF_DOCUMENT_ID,
          task: { toPromise: () => never },
        }))
        .mockImplementationOnce(() => { throw new Error('raw engine failure'); });
      const controller = createReferenceDocumentController({
        documentManager: {
          openDocumentUrl,
          retryDocument: vi.fn(),
          closeDocument,
          getActiveDocumentId: () => MAIN_PDF_DOCUMENT_ID,
          getDocumentState: () => null,
        },
        assetUrls: { pdfiumWasm: '/pdfium.wasm', documentUrl: '/document.pdf' },
        origin: 'http://127.0.0.1:4173', documentGeneration: 1, timeoutMs: 20,
      });

      const stalled = controller.open();
      await vi.advanceTimersByTimeAsync(21);
      expect(await stalled).toBe(false);
      expect(controller.snapshot().status).toBe('failed');
      await Promise.resolve();
      expect(closeDocument).toHaveBeenCalledOnce();

      expect(await controller.retry()).toBe(false);
      expect(controller.snapshot().status).toBe('failed');
      expect(openDocumentUrl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes a newer open behind physical close settlement', async () => {
    let documentStatus: 'loaded' | undefined = 'loaded';
    const closed = deferred<void>();
    const loaded = resolvedTask(undefined);
    const openDocumentUrl = vi.fn(() => resolvedTask({
      documentId: REFERENCE_PDF_DOCUMENT_ID,
      task: loaded,
    }));
    const closeDocument = vi.fn(() => ({
      toPromise: () => closed.promise.then(() => { documentStatus = undefined; }),
    }));
    const controller = createReferenceDocumentController({
      documentManager: {
        openDocumentUrl,
        retryDocument: vi.fn(),
        closeDocument,
        getActiveDocumentId: () => MAIN_PDF_DOCUMENT_ID,
        getDocumentState: () => documentStatus === undefined ? null : { status: documentStatus },
      },
      assetUrls: { pdfiumWasm: '/pdfium.wasm', documentUrl: '/document.pdf' },
      origin: 'http://127.0.0.1:4173',
      documentGeneration: 1,
    });

    const close = controller.close();
    const reopen = controller.open();
    await Promise.resolve();
    expect(openDocumentUrl).not.toHaveBeenCalled();
    closed.resolve();
    await close;
    expect(await reopen).toBe(true);
    expect(closeDocument).toHaveBeenCalledOnce();
    expect(openDocumentUrl).toHaveBeenCalledOnce();
    expect(controller.snapshot()).toMatchObject({ status: 'loaded', documentGeneration: 1 });
  });

  it('uses one tracked close when an invalidated open is followed by a queued reopen', async () => {
    const oldLoad = deferred<void>();
    const physicalClose = deferred<void>();
    let openCount = 0;
    let documentStatus: 'loading' | undefined = 'loading';
    const openDocumentUrl = vi.fn(() => {
      openCount += 1;
      return resolvedTask({
        documentId: REFERENCE_PDF_DOCUMENT_ID,
        task: openCount === 1
          ? { toPromise: () => oldLoad.promise }
          : resolvedTask(undefined),
      });
    });
    const closeDocument = vi.fn(() => ({
      toPromise: () => physicalClose.promise.then(() => { documentStatus = undefined; }),
    }));
    const controller = createReferenceDocumentController({
      documentManager: {
        openDocumentUrl,
        retryDocument: vi.fn(),
        closeDocument,
        getActiveDocumentId: () => MAIN_PDF_DOCUMENT_ID,
        getDocumentState: () => documentStatus === undefined ? null : { status: documentStatus },
      },
      assetUrls: { pdfiumWasm: '/pdfium.wasm', documentUrl: '/document.pdf' },
      origin: 'http://127.0.0.1:4173', documentGeneration: 1,
    });

    const staleOpen = controller.open();
    const replacement = controller.replaceDocument(2);
    const reopened = controller.open();
    oldLoad.resolve();
    expect(await staleOpen).toBe(false);
    await Promise.resolve();
    expect(closeDocument).toHaveBeenCalledOnce();
    expect(openDocumentUrl).toHaveBeenCalledOnce();

    physicalClose.resolve();
    await replacement;
    expect(await reopened).toBe(true);
    expect(closeDocument).toHaveBeenCalledOnce();
    expect(openDocumentUrl).toHaveBeenCalledTimes(2);
    expect(controller.snapshot()).toMatchObject({ status: 'loaded', documentGeneration: 2 });
  });

  it('coalesces repeated close requests without an intervening open', async () => {
    const closeDocument = vi.fn(() => resolvedTask(undefined));
    const controller = createReferenceDocumentController({
      documentManager: {
        openDocumentUrl: vi.fn(),
        retryDocument: vi.fn(),
        closeDocument,
        getActiveDocumentId: () => MAIN_PDF_DOCUMENT_ID,
        getDocumentState: () => null,
      },
      assetUrls: { pdfiumWasm: '/pdfium.wasm', documentUrl: '/document.pdf' },
      origin: 'http://127.0.0.1:4173',
      documentGeneration: 1,
    });

    const first = controller.close();
    const second = controller.close();
    expect(second).toBe(first);
    await second;
    expect(closeDocument).toHaveBeenCalledOnce();
  });

  it('closes an active loaded clone and validates ownership again on retry', async () => {
    let activeDocumentId = REFERENCE_PDF_DOCUMENT_ID;
    let documentStatus: 'loaded' | null = 'loaded';
    const closeDocument = vi.fn(() => resolvedTask(undefined));
    const openDocumentUrl = vi.fn(() => {
      documentStatus = 'loaded';
      activeDocumentId = MAIN_PDF_DOCUMENT_ID;
      return resolvedTask({
        documentId: REFERENCE_PDF_DOCUMENT_ID,
        task: resolvedTask(undefined),
      });
    });
    closeDocument.mockImplementation(() => {
      documentStatus = null;
      activeDocumentId = MAIN_PDF_DOCUMENT_ID;
      return resolvedTask(undefined);
    });
    const controller = createReferenceDocumentController({
      documentManager: {
        openDocumentUrl,
        retryDocument: vi.fn(),
        closeDocument,
        getActiveDocumentId: () => activeDocumentId,
        getDocumentState: () => documentStatus === null ? null : { status: documentStatus },
      },
      assetUrls: { pdfiumWasm: '/pdfium.wasm', documentUrl: '/document.pdf' },
      origin: 'http://127.0.0.1:4173', documentGeneration: 1,
    });

    expect(await controller.open()).toBe(false);
    expect(controller.snapshot().status).toBe('failed');
    await Promise.resolve();
    expect(closeDocument).toHaveBeenCalledOnce();

    expect(await controller.retry()).toBe(true);
    expect(openDocumentUrl).toHaveBeenCalledOnce();
    expect(controller.snapshot().status).toBe('loaded');
  });

  it('bounds a stalled physical close so a later open can proceed', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<void>(() => undefined);
      const openDocumentUrl = vi.fn(() => resolvedTask({
        documentId: REFERENCE_PDF_DOCUMENT_ID,
        task: resolvedTask(undefined),
      }));
      const controller = createReferenceDocumentController({
        documentManager: {
          openDocumentUrl,
          retryDocument: vi.fn(),
          closeDocument: vi.fn(() => ({ toPromise: () => never })),
          getActiveDocumentId: () => MAIN_PDF_DOCUMENT_ID,
          getDocumentState: () => null,
        },
        assetUrls: { pdfiumWasm: '/pdfium.wasm', documentUrl: '/document.pdf' },
        origin: 'http://127.0.0.1:4173', documentGeneration: 1, timeoutMs: 20,
      });

      const close = controller.close();
      const reopen = controller.open();
      await vi.advanceTimersByTimeAsync(21);
      await close;
      expect(await reopen).toBe(true);
      expect(openDocumentUrl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
