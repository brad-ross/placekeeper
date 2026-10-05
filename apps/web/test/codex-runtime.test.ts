import { describe, expect, it } from 'vitest';
import { validateViewerResourceUrl } from '../src/pdf/embedpdf-viewer.js';

describe('Codex viewer resources', () => {
  it('accepts only verified native resources in their issued role', () => {
    const policy = { host: 'codex' as const, resources: { document: 'blob:https://native/pdf', pdfiumWasm: 'blob:https://native/wasm', worker: 'blob:https://native/worker' } };
    expect(validateViewerResourceUrl(policy.resources.document, policy)).toBe(policy.resources.document);
    expect(() => validateViewerResourceUrl(policy.resources.worker, policy)).toThrow();
    expect(() => validateViewerResourceUrl('https://native/pdf', policy)).toThrow();
  });
});

import { vi } from 'vitest';
import { createReviewState } from '../../../packages/core/src/review-model.js';
import { createCodexHostRuntime } from '../src/host/codex-runtime.js';
import { setAnnotationName } from '../../../packages/core/src/review-commands.js';

const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const state = createReviewState({ sessionId, source: { fileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', digest: 'a'.repeat(64), byteLength: 3 } });
function fixture() {
  let revision = 0;
  let failResource: boolean | 'worker' = false;
  let engineDigest = 'a';
  let nextHandle = 'document_handle_1234';
  let documentDigest = 'a';
  const descriptors = () => Object.fromEntries([['document', 'application/pdf', nextHandle], ['pdfiumWasm', 'application/wasm', `wasm_handle_${engineDigest.repeat(8)}`], ['worker', 'text/javascript', `worker_handle_${engineDigest.repeat(8)}`]].map(([role, mediaType, handle]) => [role, { handle, mediaType, byteLength: 3, sha256: (role === 'document' ? documentDigest : engineDigest).repeat(64) }]));
  const call = vi.fn(async (method: string, payload: any): Promise<unknown> => {
    if (method === 'bootstrap') return { sessionId, generation: 1, revision, state: { ...state, revision }, scope: { documentTitle: 'Paper.pdf', launchSurface: 'codex' }, saveStatus: { destination: { phase: 'none', generation: 0 }, sync: { phase: 'clean', desiredRevision: 0, savedRevision: 0 } }, resources: Object.fromEntries(Object.entries(descriptors()).map(([role, descriptor]: [string, any]) => [role, descriptor.handle])), resourceDescriptors: descriptors(), capabilities: { interactionLifecycleVersion: 1 }, location: { kind: 'page', page: 4 } };
    if (method === 'resource') { if (!Object.values(descriptors()).some((descriptor: any) => descriptor.handle === payload.handle)) throw new Error('unissued handle'); if (failResource === true || failResource === 'worker' && payload.handle.startsWith('worker')) throw new Error('transfer failed'); return { offset: payload.offset, dataBase64: btoa(payload.handle === nextHandle ? `${documentDigest}bc` : `${engineDigest}bc`), done: true }; }
    if (method === 'command') { revision++; return { ...state, revision }; }
    if (method === 'saveStatus') return { destination: { phase: 'none', generation: 0 }, sync: { phase: 'clean', desiredRevision: revision, savedRevision: 0 } };
    return {};
  });
  const revokeObjectURL = vi.fn();
  let urlIndex = 0;
  const created: string[] = [];
  const runtime = createCodexHostRuntime({ runtimeId: 'runtime_identifier_1234', call, subscribeInvalidations: () => () => {} }, { digest: async bytes => String.fromCharCode(bytes[0]!).repeat(64), createObjectURL: () => { const url = `blob:https://native/${++urlIndex}`; created.push(url); return url; }, revokeObjectURL });
  return { runtime, call, revokeObjectURL, created, changeEngine(digest: string) { engineDigest = digest; }, failWorker() { failResource = 'worker'; }, changeDocument(digest = 'b') { documentDigest = digest; nextHandle = `document_handle_${digest.repeat(8)}`; }, fail() { failResource = true; }, recover() { failResource = false; } };
}

describe('admitted Codex production runtime', () => {
  it('materializes verified assets once, negotiates authoring and preserves native location history', async () => {
    const f = fixture();
    const initial = await f.runtime.bootstrap();
    expect(initial.resourcePolicy.host).toBe('codex');
    expect(initial.viewerAssets.pdfiumWasmBytes).toEqual(new Uint8Array([97, 98, 99]));
    expect(initial.viewerAssets.documentBytes).toBeDefined();
    expect(f.runtime.capabilities).toEqual({ localDocumentRefresh: false, interactionLifecycleVersion: 1 });
    expect(initial.locationHistory?.read()).toEqual({ kind: 'page', page: 4 });
    await f.runtime.bootstrap();
    const chunks = f.call.mock.calls.filter(([method]) => method === 'resource');
    expect(chunks).toHaveLength(3);
    expect(chunks.map(([, payload]) => payload.handle)).toEqual(expect.arrayContaining(['document_handle_1234', 'wasm_handle_aaaaaaaa', 'worker_handle_aaaaaaaa']));
    f.runtime.dispose();
    await vi.waitFor(() => expect(f.revokeObjectURL).toHaveBeenCalledTimes(3));
  });
  it('accepts a canonical command response ahead of its last bootstrap projection', async () => {
    const f = fixture(); await f.runtime.bootstrap();
    const result = await f.runtime.command(setAnnotationName(state, 'Reviewer'));
    expect(result).toMatchObject({ revision: 1 });
    await expect(f.runtime.saveStatus()).resolves.toMatchObject({ sync: { desiredRevision: 1 } });
    f.runtime.dispose();
  });
  it('keeps the valid resource through failed replacement and retries without leaking URLs', async () => {
    const f = fixture(); const initial = await f.runtime.bootstrap();
    f.changeDocument(); f.fail();
    await expect(f.runtime.bootstrap()).rejects.toThrow();
    expect(f.revokeObjectURL).not.toHaveBeenCalled();
    f.recover(); const next = await f.runtime.bootstrap();
    expect(next.viewerAssets.documentUrl).not.toBe(initial.viewerAssets.documentUrl);
    f.runtime.dispose();
    await vi.waitFor(() => expect(f.revokeObjectURL).toHaveBeenCalledTimes(4));
  });
  it('rejects chunk completion after disposal without publishing a Blob', async () => {
    const completions: ((value: unknown) => void)[] = [];
    const f = fixture();
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation((method, payload) => method === 'resource' ? new Promise(resolve => { completions.push(resolve); }) : original(method, payload));
    const bootstrap = f.runtime.bootstrap();
    await vi.waitFor(() => expect(completions).toHaveLength(3));
    f.runtime.dispose(); for (const complete of completions) complete({ offset: 0, dataBase64: btoa('abc'), done: true });
    await expect(bootstrap).rejects.toThrow();
    expect(f.revokeObjectURL).not.toHaveBeenCalled();
  });
});

it('rejects a failed initial service bootstrap immediately so the entry can offer retry', async () => {
  const f = fixture(); f.call.mockRejectedValueOnce(new Error('bootstrap failed'));
  await expect(f.runtime.bootstrap()).rejects.toThrow('could not be verified');
  await expect(f.runtime.bootstrap()).resolves.toMatchObject({ sessionId });
  f.runtime.dispose();
});

it('does not let a late obsolete bootstrap replace the current manifest', async () => {
  const f = fixture(); const original = f.call.getMockImplementation()!;
  const stale = await original('bootstrap', {});
  let finish!: (value: unknown) => void;
  f.call.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const obsolete = f.runtime.bootstrap();
  f.changeDocument('b');
  const current = await f.runtime.bootstrap();
  finish(stale);
  await expect(obsolete).rejects.toMatchObject({ name: 'AbortError' });
  const repeated = await f.runtime.bootstrap();
  expect(repeated.viewerAssets.documentUrl).toBe(current.viewerAssets.documentUrl);
  f.runtime.dispose();
});

it('pins the last complete view across partial replacements and bounds completed resources', async () => {
  const f = fixture(); const initial = await f.runtime.bootstrap();
  const originalURLs = [initial.viewerAssets.documentUrl, initial.viewerAssets.pdfiumWasm, initial.viewerAssets.workerUrl];
  for (const digest of ['b', 'c', 'd', 'e']) {
    f.changeDocument(digest); f.changeEngine(digest); f.failWorker();
    await expect(f.runtime.bootstrap()).rejects.toThrow();
    await vi.waitFor(() => expect(f.created.length - f.revokeObjectURL.mock.calls.length).toBe(3));
    expect(f.revokeObjectURL.mock.calls.some(([url]) => originalURLs.includes(url))).toBe(false);
  }
  f.recover();
  for (const digest of ['b', 'c', 'd', 'e']) {
    f.changeDocument(digest); f.changeEngine(digest); await f.runtime.bootstrap();
    await vi.waitFor(() => expect(f.created.length - f.revokeObjectURL.mock.calls.length).toBeLessThanOrEqual(6));
  }
  f.runtime.dispose();
  await vi.waitFor(() => expect(f.revokeObjectURL.mock.calls).toHaveLength(f.created.length));
});
