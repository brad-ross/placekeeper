import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PdfWriteRequest, PdfWriteResult, PdfWriter } from '../../core/src/pdf-writer.js';
import { runPdfBackend } from '../src/backend-host.js';

const bytes = new Uint8Array([1, 2, 3]);
const digest = createHash('sha256').update(bytes).digest('hex');
const request: PdfWriteRequest = {
  sourcePdf: bytes, sourceSha256: digest, revision: 1, annotations: [],
};
const result: PdfWriteResult = {
  pdfBytes: bytes,
  evidence: {
    backend: 'embedpdf', backendVersion: 'test', originalSha256: digest,
    outputSha256: digest, pageCount: 1, structurallyValid: true,
    annotations: [], preexistingAnnotationIds: [],
  },
};

afterEach(() => vi.useRealTimers());

describe('PDF backend resource lifetime', () => {
  it.each(['success', 'rejection', 'throw', 'invalid-output'] as const)(
    'releases timers and abort listeners after %s', async (outcome) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const error = new Error('writer failed');
      const writer: PdfWriter = {
        write: () => {
          if (outcome === 'throw') throw error;
          return outcome === 'rejection' ? Promise.reject(error) : Promise.resolve(result);
        },
      };
      const pending = runPdfBackend(writer, request, {
        signal: controller.signal,
        ...(outcome === 'invalid-output' ? { maxOutputBytes: 1 } : {}),
      });
      if (outcome === 'success') await expect(pending).resolves.toBe(result);
      else if (outcome === 'invalid-output') await expect(pending).rejects.toMatchObject({ code: 'resource-limit' });
      else await expect(pending).rejects.toBe(error);
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    },
  );

  it.each(['timeout', 'cancelled'] as const)('releases resources after %s', async (code) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = runPdfBackend({ write: () => new Promise(() => {}) }, request, {
      signal: controller.signal, timeoutMs: 10,
    });
    const rejection = expect(pending).rejects.toMatchObject({ code });
    if (code === 'timeout') await vi.advanceTimersByTimeAsync(10);
    else controller.abort();
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
