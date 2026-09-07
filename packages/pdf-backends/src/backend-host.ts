import { createHash } from 'node:crypto';

import type {
  PdfWriteRequest,
  PdfWriteResult,
  PdfWriter,
} from '../../core/src/pdf-writer.js';
import { PdfWriterError } from '../../core/src/pdf-writer.js';

export interface PdfBackendRunOptions {
  timeoutMs?: number;
  maxSourceBytes?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function runPdfBackend(
  writer: PdfWriter,
  request: PdfWriteRequest,
  options: PdfBackendRunOptions = {},
): Promise<PdfWriteResult> {
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (request.sourcePdf.byteLength > maxSourceBytes) {
    throw new PdfWriterError(
      'resource-limit',
      `Source PDF exceeds the ${maxSourceBytes}-byte backend limit.`,
    );
  }
  if (sha256(request.sourcePdf) !== request.sourceSha256) {
    throw new PdfWriterError(
      'source-digest-mismatch',
      'Source PDF bytes do not match the frozen source digest.',
    );
  }

  const signal = options.signal;
  let onAbort: (() => void) | undefined;
  const abort = signal === undefined ? undefined : new Promise<never>((_, reject) => {
    onAbort = () => reject(new PdfWriterError('cancelled', 'PDF write was cancelled.'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new PdfWriterError('timeout', `PDF backend exceeded ${timeoutMs} ms.`)),
      timeoutMs,
    );
    timer.unref?.();
  });

  try {
    const pending: Array<Promise<PdfWriteResult>> = [writer.write(request), timeout];
    if (abort) pending.push(abort);
    const result = await Promise.race(pending);

    if (result.pdfBytes.byteLength > maxOutputBytes) {
      throw new PdfWriterError(
        'resource-limit',
        `Output PDF exceeds the ${maxOutputBytes}-byte backend limit.`,
      );
    }
    if (sha256(result.pdfBytes) !== result.evidence.outputSha256) {
      throw new PdfWriterError('backend-error', 'Backend output digest does not match its evidence.');
    }
    return result;
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  }
}
