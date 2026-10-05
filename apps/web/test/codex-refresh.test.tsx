import { describe, expect, it, vi } from 'vitest';
import { createReviewState } from '../../../packages/core/src/review-model.js';
import { createCodexHostRuntime } from '../src/host/codex-runtime.js';
import { loadRuntimeDocumentSource, subscribeRuntimeDocumentSource } from '../src/host/runtime-document-source.js';
import type { HostRuntimeInvalidation } from '../src/host/runtime.js';

const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const state = createReviewState({ sessionId, source: { fileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', digest: 'a'.repeat(64), byteLength: 3 } });
function fixture() {
  let revision = 0;
  let generation = 1;
  const listeners = new Set<(event: HostRuntimeInvalidation) => void>();
  let failResource: boolean | 'worker' = false;
  let engineDigest = 'a';
  let nextHandle = 'document_handle_1234';
  let documentDigest = 'a';
  const descriptors = () => Object.fromEntries([['document', 'application/pdf', nextHandle], ['pdfiumWasm', 'application/wasm', `wasm_handle_${engineDigest.repeat(8)}`], ['worker', 'text/javascript', `worker_handle_${engineDigest.repeat(8)}`]].map(([role, mediaType, handle]) => [role, { handle, mediaType, byteLength: 3, sha256: (role === 'document' ? documentDigest : engineDigest).repeat(64) }]));
  const call = vi.fn(async (method: string, payload: any): Promise<unknown> => {
    if (method === 'bootstrap') return { sessionId, generation, revision, state: { ...state, revision, workflow: { ...state.workflow, documentGeneration: generation } }, scope: { documentTitle: 'Paper.pdf', launchSurface: 'codex' }, saveStatus: { destination: { phase: 'none', generation: 0 }, sync: { phase: 'clean', desiredRevision: 0, savedRevision: 0 } }, resources: Object.fromEntries(Object.entries(descriptors()).map(([role, descriptor]: [string, any]) => [role, descriptor.handle])), resourceDescriptors: descriptors(), capabilities: { localDocumentRefresh: true, interactionLifecycleVersion: 1 }, location: { kind: 'page', page: 4 } };
    if (method === 'resource') { if (!Object.values(descriptors()).some((descriptor: any) => descriptor.handle === payload.handle)) throw new Error('unissued handle'); if (failResource === true || failResource === 'worker' && payload.handle.startsWith('worker')) throw new Error('transfer failed'); return { offset: payload.offset, dataBase64: btoa(payload.handle === nextHandle ? `${documentDigest}bc` : `${engineDigest}bc`), done: true }; }
    if (method === 'command') { revision++; return { ...state, revision }; }
    if (method === 'saveStatus') return { destination: { phase: 'none', generation: 0 }, sync: { phase: 'clean', desiredRevision: revision, savedRevision: 0 } };
    return {};
  });
  const revokeObjectURL = vi.fn();
  let urlIndex = 0;
  const created: string[] = [];
  const runtime = createCodexHostRuntime({ runtimeId: 'runtime_identifier_1234', call, subscribeInvalidations: listener => { listeners.add(listener); return () => listeners.delete(listener); } }, { digest: async bytes => String.fromCharCode(bytes[0]!).repeat(64), createObjectURL: () => { const url = `blob:https://native/${++urlIndex}`; created.push(url); return url; }, revokeObjectURL });
  return { update(nextGeneration: number, nextRevision: number, reason: HostRuntimeInvalidation["reason"]) { generation = nextGeneration; revision = nextRevision; for (const listener of listeners) listener({ sessionId, generation, revision, reason }); }, runtime, call, revokeObjectURL, created, changeEngine(digest: string) { engineDigest = digest; }, failWorker() { failResource = 'worker'; }, changeDocument(digest = 'b') { documentDigest = digest; nextHandle = `document_handle_${digest.repeat(8)}`; }, fail() { failResource = true; }, recover() { failResource = false; } };
}


describe('Codex canonical refresh composition', () => {
  it('updates same-generation state without rematerializing bytes or resetting reading history', async () => {
    const f = fixture(), initial = await f.runtime.bootstrap();
    initial.locationHistory!.replace({ kind: 'page', page: 7 });
    const publish = vi.fn();
    const unsubscribe = subscribeRuntimeDocumentSource(f.runtime, initial, publish);
    f.update(1, 1, 'revision');
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const loaded = publish.mock.calls[0]![0].loaded;
    expect(loaded.state.revision).toBe(1);
    expect(loaded.viewerAssets.documentUrl).toBe(initial.viewerAssets.documentUrl);
    expect(loaded.locationHistory.read()).toEqual({ kind: 'page', page: 7 });
    expect(f.runtime.capabilities?.localDocumentRefresh).toBe(true);
    expect(f.call.mock.calls.filter(([method]) => method === 'resource')).toHaveLength(3);
    unsubscribe(); f.runtime.dispose();
  });

  it('retains the last verified PDF during failed materialization, then publishes the canonical successor', async () => {
    const f = fixture(), initial = await f.runtime.bootstrap();
    const publish = vi.fn();
    const unsubscribe = subscribeRuntimeDocumentSource(f.runtime, initial, publish);
    f.changeDocument(); f.fail(); f.update(2, 1, 'generation');
    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({ loaded: initial, refreshStatus: 'failed' }));
    expect(f.revokeObjectURL).not.toHaveBeenCalled();
    f.recover();
    await vi.waitFor(() => expect(publish.mock.calls.at(-1)![0]).toMatchObject({ loaded: { generation: 2 }, refreshStatus: 'idle' }));
    expect(publish.mock.calls.at(-1)![0].loaded.viewerAssets.documentUrl).not.toBe(initial.viewerAssets.documentUrl);
    unsubscribe(); f.runtime.dispose();
  });
});

it('restarts initial acquisition on a canonical generation invalidation before the shared reader subscribes', async () => {
  const f = fixture();
  const original = f.call.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  const stale = await original('bootstrap', {});
  f.call.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const loaded = vi.fn(), failed = vi.fn();
  const cleanup = loadRuntimeDocumentSource(f.runtime, loaded, failed);
  f.changeDocument(); f.update(2, 1, 'generation');
  await vi.waitFor(() => expect(loaded).toHaveBeenCalledWith(expect.objectContaining({ generation: 2 })));
  finish(stale);
  await Promise.resolve();
  expect(loaded).toHaveBeenCalledOnce(); expect(failed).not.toHaveBeenCalled();
  cleanup(); f.runtime.dispose();
});
