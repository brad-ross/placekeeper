import type {
  PdfRewriteEligibility,
  PdfWriteRequest,
  PdfWriteResult,
  PdfWriter,
} from '../../core/src/pdf-writer.js';

export interface DisposablePdfWriter extends PdfWriter {
  dispose?(): void | Promise<void>;
}

export class BrowserDocumentSessionError extends Error {
  readonly code: 'cancelled' | 'closed' | 'operation-in-progress' | 'timeout';

  constructor(
    code: BrowserDocumentSessionError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'BrowserDocumentSessionError';
    this.code = code;
  }
}

export interface BrowserDocumentSession {
  assess(
    sourcePdf: Uint8Array,
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<PdfRewriteEligibility>;
  write(
    request: PdfWriteRequest,
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<PdfWriteResult>;
  dispose(): Promise<void>;
}

function cancellationError(): BrowserDocumentSessionError {
  return new BrowserDocumentSessionError('cancelled', 'The PDF operation was cancelled.');
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(cancellationError());
      return;
    }
    signal.addEventListener('abort', () => reject(cancellationError()), { once: true });
  });
}

export function createBrowserDocumentSession(options: {
  readonly createWriter: () => DisposablePdfWriter | Promise<DisposablePdfWriter>;
  readonly operationTimeoutMs: number;
}): BrowserDocumentSession {
  let writerPromise: Promise<DisposablePdfWriter> | undefined;
  let teardown: Promise<void> | undefined;
  let active = false;
  let closed = false;
  let epoch = 0;
  let operationController: AbortController | undefined;

  const getWriter = async (): Promise<DisposablePdfWriter> => {
    if (closed) throw new BrowserDocumentSessionError('closed', 'This PDF session is closed.');
    writerPromise ??= Promise.resolve(options.createWriter()).then((created) => {
      return created;
    });
    return writerPromise;
  };

  const teardownWriter = async (): Promise<void> => {
    if (teardown !== undefined) return teardown;
    const pendingWriter = writerPromise;
    writerPromise = undefined;
    teardown = (async () => {
      if (pendingWriter === undefined) return;
      const ownedWriter = await pendingWriter.catch(() => undefined);
      await ownedWriter?.dispose?.();
    })().finally(() => {
      teardown = undefined;
    });
    return teardown;
  };

  const run = async <T>(
    execute: (ownedWriter: DisposablePdfWriter) => Promise<T>,
    operationOptions: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
    timeoutMessage: string,
  ): Promise<T> => {
    if (closed) throw new BrowserDocumentSessionError('closed', 'This PDF session is closed.');
    if (active) {
      throw new BrowserDocumentSessionError(
        'operation-in-progress',
        'Another PDF operation is already in progress.',
      );
    }
    if (operationOptions.signal?.aborted) throw cancellationError();

    active = true;
    const operationEpoch = epoch;
    const controller = new AbortController();
    operationController = controller;
    const relayAbort = () => controller.abort();
    operationOptions.signal?.addEventListener('abort', relayAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutMs = operationOptions.timeoutMs ?? options.operationTimeoutMs;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = globalThis.setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new BrowserDocumentSessionError('timeout', timeoutMessage));
      }, timeoutMs);
    });

    try {
      const operation = getWriter().then(execute);
      const result = await Promise.race([
        operation,
        timeout,
        waitForAbort(controller.signal),
      ]);
      if (closed || epoch !== operationEpoch) throw cancellationError();
      return result;
    } catch (error) {
      const cancelled = error instanceof BrowserDocumentSessionError
        && error.code === 'cancelled';
      const timeoutFailure = timedOut || (
        error instanceof BrowserDocumentSessionError && error.code === 'timeout'
      );
      if (cancelled || timeoutFailure || controller.signal.aborted) {
        epoch += 1;
        await teardownWriter();
        if (timedOut || timeoutFailure) {
          throw new BrowserDocumentSessionError('timeout', timeoutMessage);
        }
        throw cancellationError();
      }
      throw error;
    } finally {
      if (timer !== undefined) globalThis.clearTimeout(timer);
      operationOptions.signal?.removeEventListener('abort', relayAbort);
      controller.abort();
      if (operationController === controller) operationController = undefined;
      active = false;
    }
  };

  return {
    assess(sourcePdf, operationOptions = {}) {
      return run(async (ownedWriter) => (
        ownedWriter.assess?.(sourcePdf) ?? { eligible: true }
      ), operationOptions, 'PDF assessment timed out.');
    },
    write(request, operationOptions = {}) {
      return run(
        (ownedWriter) => ownedWriter.write(request),
        operationOptions,
        'PDF export timed out. Try again.',
      );
    },
    async dispose() {
      if (closed) {
        await teardown;
        return;
      }
      closed = true;
      epoch += 1;
      operationController?.abort();
      await teardownWriter();
    },
  };
}
