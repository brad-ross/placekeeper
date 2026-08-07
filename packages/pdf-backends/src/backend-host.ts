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

function abortPromise(signal: AbortSignal | undefined): Promise<never> | undefined {
  if (!signal) return undefined;
  if (signal.aborted) {
    return Promise.reject(new PdfWriterError('cancelled', 'PDF write was cancelled.'));
  }
  return new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new PdfWriterError('cancelled', 'PDF write was cancelled.')),
      { once: true },
    );
  });
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

  const abort = abortPromise(options.signal);
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new PdfWriterError('timeout', `PDF backend exceeded ${timeoutMs} ms.`)),
      timeoutMs,
    );
    timer.unref?.();
  });

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
}
