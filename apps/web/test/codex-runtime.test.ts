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
import { NativeOperationError } from '../../../packages/core/src/codex-mcp-protocol.js';
import { createCodexHostRuntime } from '../src/host/codex-runtime.js';
import { loadRuntimeDocumentSource } from '../src/host/runtime-document-source.js';
import { setAnnotationName } from '../../../packages/core/src/review-commands.js';

const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const state = createReviewState({ sessionId, source: { fileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', digest: 'a'.repeat(64), byteLength: 3 } });
function fixture() {
  let revision = 0;
  let generation = 1;
  let invalidate: ((event: any) => void) | undefined;
  let failResource: boolean | 'worker' = false;
  let engineDigest = 'a';
  let nextHandle = 'document_handle_1234';
  let documentDigest = 'a';
  const descriptors = () => Object.fromEntries([['document', 'application/pdf', nextHandle], ['pdfiumWasm', 'application/wasm', `wasm_handle_${engineDigest.repeat(8)}`], ['worker', 'text/javascript', `worker_handle_${engineDigest.repeat(8)}`]].map(([role, mediaType, handle]) => [role, { handle, mediaType, byteLength: 3, sha256: (role === 'document' ? documentDigest : engineDigest).repeat(64) }]));
  const call = vi.fn(async (method: string, payload: any): Promise<unknown> => {
    if (method === 'bootstrap') return { sessionId, generation, revision, state: { ...state, revision, workflow: { ...state.workflow, documentGeneration: generation } }, scope: { documentTitle: 'Paper.pdf', launchSurface: 'codex' }, saveStatus: { destination: { phase: 'none', generation: 0 }, sync: { phase: 'clean', desiredRevision: 0, savedRevision: 0 } }, resources: Object.fromEntries(Object.entries(descriptors()).map(([role, descriptor]: [string, any]) => [role, descriptor.handle])), resourceDescriptors: descriptors(), capabilities: { interactionLifecycleVersion: 1 }, location: { kind: 'page', page: 4 } };
    if (method === 'resource') { if (!Object.values(descriptors()).some((descriptor: any) => descriptor.handle === payload.handle)) throw new Error('unissued handle'); if (failResource === true || failResource === 'worker' && payload.handle.startsWith('worker')) throw new Error('transfer failed'); return { offset: payload.offset, dataBase64: btoa(payload.handle === nextHandle ? `${documentDigest}bc` : `${engineDigest}bc`), done: true }; }
    if (method === 'command') { revision++; return { ...state, revision }; }
    if (method === 'saveStatus') return { destination: { phase: 'none', generation: 0 }, sync: { phase: 'clean', desiredRevision: revision, savedRevision: 0 } };
    return {};
  });
  const revokeObjectURL = vi.fn();
  let urlIndex = 0;
  const created: string[] = [];
  const runtime = createCodexHostRuntime({ runtimeId: 'runtime_identifier_1234', call, subscribeInvalidations: listener => { invalidate = listener; return () => { invalidate = undefined; }; } }, { digest: async bytes => String.fromCharCode(bytes[0]!).repeat(64), createObjectURL: () => { const url = `blob:https://native/${++urlIndex}`; created.push(url); return url; }, revokeObjectURL });
  return { runtime, call, revokeObjectURL, created, replace() { generation++; invalidate?.({ sessionId, generation, revision, reason: "generation" }); }, changeEngine(digest: string) { engineDigest = digest; }, failWorker() { failResource = 'worker'; }, changeDocument(digest = 'b') { documentDigest = digest; nextHandle = `document_handle_${digest.repeat(8)}`; }, fail() { failResource = true; }, recover() { failResource = false; } };
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


it('restarts pending native resource transfers after generation replacement without manual retry', async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  const completions: (() => Promise<void>)[] = [];
  let holding = true;
  f.call.mockImplementation(async (method, payload) => {
    if (method !== 'resource' || !holding) return original(method, payload);
    const reply = await original(method, payload);
    return new Promise(resolve => { completions.push(async () => { resolve(reply); }); });
  });
  const loaded = vi.fn(), failed = vi.fn();
  const stop = loadRuntimeDocumentSource(f.runtime, loaded, failed);
  await vi.waitFor(() => expect(completions).toHaveLength(3));
  holding = false; f.changeDocument('b'); f.replace();
  await Promise.all(completions.map(complete => complete()));
  await vi.waitFor(() => expect(loaded).toHaveBeenCalledTimes(1));
  expect(loaded.mock.calls[0]![0]).toMatchObject({ generation: 2 });
  expect(failed).not.toHaveBeenCalled();
  expect(f.call.mock.calls.filter(([method]) => method === 'resource')).toHaveLength(6);
  await f.runtime.bootstrap();
  expect(f.call.mock.calls.filter(([method]) => method === 'resource')).toHaveLength(6);
  stop(); f.runtime.dispose();
  await vi.waitFor(() => expect(f.revokeObjectURL.mock.calls).toHaveLength(f.created.length));
});


it('restarts same-generation pending manifests and retains only fulfilled verified entries', async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  const completions: (() => void)[] = [];
  let holding = true;
  f.call.mockImplementation(async (method, payload) => {
    if (method !== 'resource' || !holding) return original(method, payload);
    const reply = await original(method, payload);
    return new Promise(resolve => { completions.push(() => resolve(reply)); });
  });
  const obsolete = f.runtime.bootstrap().catch(error => error);
  await vi.waitFor(() => expect(completions).toHaveLength(3));
  holding = false;
  const current = await f.runtime.bootstrap();
  completions.forEach(complete => complete());
  expect(await obsolete).toMatchObject({ message: 'stale-or-invalid-resource' });
  const repeated = await f.runtime.bootstrap();
  expect(repeated.viewerAssets.documentUrl).toBe(current.viewerAssets.documentUrl);
  expect(f.call.mock.calls.filter(([method]) => method === 'resource')).toHaveLength(6);
  f.runtime.dispose();
  await vi.waitFor(() => expect(f.revokeObjectURL.mock.calls).toHaveLength(f.created.length));
});

it('maps only typed current native export conflicts to shared recovery guidance', async () => {
  const f = fixture(); await f.runtime.bootstrap();
  f.call.mockRejectedValueOnce(new NativeOperationError());
  await expect(f.runtime.exportReviewedCopy?.(undefined, { expectedRevision: 0, documentGeneration: 1 })).rejects.toThrow('Review changed. Confirm the annotation name again to export the latest review.');
  f.call.mockRejectedValueOnce(new Error('/private/service/path'));
  await expect(f.runtime.exportReviewedCopy?.(undefined, { expectedRevision: 0, documentGeneration: 1 })).rejects.toThrow('The native review action or resource could not be verified.');
  f.runtime.dispose();
});
