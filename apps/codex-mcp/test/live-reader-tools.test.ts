import { expect, it } from 'vitest';
import { LiveReaderTools } from '../src/live-reader-tools.js';
import type { ReviewAgentActions } from '../../web/src/host/review-agent-bridge.js';
import type { DocumentModelContext } from '../src/live-reader-tools.js';
const snapshot = { documentGeneration: 4, reviewRevision: 2, title: 'PDF', source: { fileId: 'file', digest: 'digest' }, page: 1, pageCount: 3, selection: null, annotations: [] };
it('registers tools when the host has no unregister method', () => {
  let attempts = 0;
  const bridge = new LiveReaderTools({ registerTool: () => { attempts++; } } as unknown as DocumentModelContext, { ensureVisible: async () => true, available: () => true });
  expect(bridge.supported).toBe(true);
  expect(attempts).toBe(5);
  expect(bridge.diagnostic).toEqual({ apiPresent: true, registerTool: true, unregisterTool: false, attemptedName: 'reveal_annotation', successCount: 5 });
});

it.each([false, true])('reuses register-only names across remounts and retires the previous reader (dispose first: %s)', async disposeFirst => {
  const tools = new Map<string, any>();
  const api = { registerTool: (tool: any) => { if (tools.has(tool.name)) throw Error('duplicate'); tools.set(tool.name, tool); } };
  const host = { ensureVisible: async () => true, available: () => true };
  let finish!: (value: boolean) => void;
  let moves = 0;
  const oldBridge = new LiveReaderTools(api, host);
  oldBridge.attach({ snapshot: () => snapshot, search: async () => { throw Error('unused'); }, navigate: async () => new Promise(resolve => { finish = resolve; }) });
  const pending = tools.get('navigate_page').execute({ page: 2, documentGeneration: 4, source: snapshot.source });
  await Promise.resolve(); await Promise.resolve();
  if (disposeFirst) oldBridge.dispose();
  const replacement = new LiveReaderTools(api, host);
  replacement.attach({ snapshot: () => ({ ...snapshot, source: { fileId: 'replacement', digest: 'new' } }), search: async () => { throw Error('unused'); }, navigate: async () => { moves++; return true; } });
  oldBridge.dispose();
  finish(true);
  expect(JSON.parse(await pending).status).toBe('unavailable');
  expect(replacement.supported).toBe(true);
  expect(tools.size).toBe(5);
  expect(JSON.parse(await tools.get('navigate_page').execute({ page: 2, documentGeneration: 4, source: snapshot.source })).reason).toBe('stale-source');
  expect(moves).toBe(0);
  expect(JSON.parse(await tools.get('inspect_review').execute({})).source.fileId).toBe('replacement');
  replacement.dispose();
  expect(JSON.parse(await tools.get('inspect_review').execute({})).status).toBe('unavailable');
});

it('rejects inspection waiting on a retired register-only reader', async () => {
  const tools = new Map<string, any>();
  const api = { registerTool: (tool: any) => { tools.set(tool.name, tool); } };
  let visible!: (value: boolean) => void;
  const old = new LiveReaderTools(api, { ensureVisible: () => new Promise(resolve => { visible = resolve; }), available: () => true });
  const actions = { snapshot: () => snapshot, search: async () => { throw Error('unused'); }, navigate: async () => true };
  old.attach(actions);
  const pending = tools.get('inspect_review').execute({});
  const replacement = new LiveReaderTools(api, { ensureVisible: async () => true, available: () => true });
  replacement.attach(actions);
  visible(true);
  expect(JSON.parse(await pending).status).toBe('unavailable');
  expect(JSON.parse(await tools.get('inspect_review').execute({})).status).toBe('current');
});

it('recovers partial registration on a register-only host without duplicate names or active leftovers', async () => {
  const tools = new Map<string, any>();
  let fail = true;
  const api = { registerTool: (tool: any) => {
    if (tools.has(tool.name)) throw Error('duplicate');
    if (fail && tool.name === 'search_document') throw Error('host failure');
    tools.set(tool.name, tool);
  } };
  const host = { ensureVisible: async () => true, available: () => true };
  const failed = new LiveReaderTools(api, host);
  expect(failed.supported).toBe(false);
  expect(failed.diagnostic).toMatchObject({ successCount: 1, failureName: 'Error' });
  expect(JSON.parse(await tools.get('inspect_review').execute({})).status).toBe('unavailable');
  fail = false;
  const recovered = new LiveReaderTools(api, host);
  recovered.attach({ snapshot: () => snapshot, search: async () => { throw Error('unused'); }, navigate: async () => true });
  failed.dispose();
  expect(recovered.supported).toBe(true);
  expect(tools.size).toBe(5);
  expect(JSON.parse(await tools.get('inspect_review').execute({})).status).toBe('current');
});

it('does not let a retired full-API bridge unregister its replacement', async () => {
  const tools = new Map<string, any>();
  const api = { registerTool: (tool: any) => { if (tools.has(tool.name)) throw Error('duplicate'); tools.set(tool.name, tool); }, unregisterTool: (name: string) => { tools.delete(name); } };
  const host = { ensureVisible: async () => true, available: () => true };
  const old = new LiveReaderTools(api, host);
  const oldExecute = tools.get('inspect_review').execute;
  const replacement = new LiveReaderTools(api, host);
  replacement.attach({ snapshot: () => snapshot, search: async () => { throw Error('unused'); }, navigate: async () => true });
  old.dispose();
  expect(replacement.supported).toBe(true);
  expect(tools.size).toBe(5);
  expect(JSON.parse(await oldExecute({})).status).toBe('unavailable');
  expect(JSON.parse(await tools.get('inspect_review').execute({})).status).toBe('current');
});

it('retires and reuses retained tool names when the host throws during unregister', async () => {
  const tools = new Map<string, any>();
  let registrations = 0, oldReads = 0, replacementReads = 0;
  const api = {
    registerTool: (tool: any) => {
      registrations++;
      if (tools.has(tool.name)) throw Error('duplicate');
      tools.set(tool.name, tool);
    },
    unregisterTool: () => { throw Error('host cannot unregister'); },
  };
  const host = { ensureVisible: async () => true, available: () => true };
  const old = new LiveReaderTools(api, host);
  old.attach({ snapshot: () => { oldReads++; return snapshot; }, search: async () => { throw Error('unused'); }, navigate: async () => true });
  expect(JSON.parse(await tools.get('inspect_review').execute({})).status).toBe('current');
  old.dispose();
  expect(tools.size).toBe(5);
  for (const tool of tools.values()) expect(JSON.parse(await tool.execute({})).status).toBe('unavailable');

  const replacement = new LiveReaderTools(api, host);
  const replacementSource = { fileId: 'replacement', digest: 'new' };
  replacement.attach({ snapshot: () => { replacementReads++; return { ...snapshot, source: replacementSource }; }, search: async () => { throw Error('unused'); }, navigate: async () => true });
  old.dispose();
  expect(replacement.supported).toBe(true);
  expect(registrations).toBe(5);
  expect(JSON.parse(await tools.get('inspect_review').execute({}))).toMatchObject({ status: 'current', source: replacementSource });
  expect(oldReads).toBe(1);
  expect(replacementReads).toBe(1);
  replacement.dispose();
  for (const tool of tools.values()) expect(JSON.parse(await tool.execute({})).status).toBe('unavailable');
});

it.each(['TypeError', 'Error', 'DOMException', 'PrivateError'])('bounds registration failure diagnostics for %s and still cleans up', name => {
  const removed: string[] = [];
  const bridge = new LiveReaderTools({ registerTool: tool => { if (tool.name === 'search_document') throw { name, message: 'private grant and document details', grant: 'secret' }; }, unregisterTool: toolName => { removed.push(toolName); } }, { ensureVisible: async () => true, available: () => true });
  expect(bridge.supported).toBe(false);
  expect(removed).toEqual(['inspect_review']);
  expect(bridge.diagnostic).toEqual({ apiPresent: true, registerTool: true, unregisterTool: true, attemptedName: 'search_document', successCount: 1, failureName: name === 'PrivateError' ? 'Other' : name });
  expect(JSON.stringify(bridge.diagnostic)).not.toContain('private');
});
function fixture() {
  const tools = new Map<string, any>();
  let visible = false, moved = false;
  let finish!: (value: boolean) => void;
  const bridge = new LiveReaderTools({ registerTool: tool => { tools.set(tool.name, tool); }, unregisterTool: name => { tools.delete(name); } }, {
    ensureVisible: async () => { visible = true; return true; }, available: () => visible,
  });
  const actions: ReviewAgentActions = { snapshot: () => snapshot, search: async () => { throw Error('interrupted'); }, navigate: async () => { moved = true; return new Promise(resolve => { finish = resolve; }); } };
  const detach = bridge.attach(actions);
  return { tools, bridge, detach, finish: (v: boolean) => finish(v), moved: () => moved };
}
it('expands before navigation and waits for the reader settlement', async () => {
  const f = fixture(); let settled = false;
  const pending = f.tools.get('navigate_page').execute({ page: 2, documentGeneration: 4, source: snapshot.source }).then((v: string) => { settled = true; return JSON.parse(v); });
  await Promise.resolve(); await Promise.resolve(); expect(f.moved()).toBe(true); expect(settled).toBe(false);
  f.finish(true); expect(await pending).toMatchObject({ status: 'navigated', documentGeneration: 4, source: snapshot.source });
});
it('rejects invalid pages, stale generations, missing annotations, and detached readers', async () => {
  const f = fixture();
  for (const args of [{ page: 0, documentGeneration: 4, source: snapshot.source }, { page: 4, documentGeneration: 4, source: snapshot.source }, { page: 2, documentGeneration: 3, source: snapshot.source }]) expect(JSON.parse(await f.tools.get('navigate_page').execute(args)).status).toBe('unavailable');
  expect(JSON.parse(await f.tools.get('reveal_annotation').execute({ annotationId: 'missing', documentGeneration: 4, source: snapshot.source })).status).toBe('unavailable');
  expect(f.moved()).toBe(false); f.detach();
  expect(JSON.parse(await f.tools.get('inspect_review').execute({})).status).toBe('unavailable');
  f.bridge.dispose(); expect(f.tools.size).toBe(0);
});
it('never acknowledges a reader detached while navigation is pending', async () => {
  const f = fixture(); const pending = f.tools.get('navigate_page').execute({ page: 2, documentGeneration: 4, source: snapshot.source });
  await Promise.resolve(); await Promise.resolve(); f.detach(); f.finish(true);
  expect(JSON.parse(await pending).status).toBe('unavailable');
});
it('reports an interrupted search without document content', async () => {
  const f = fixture(); expect(JSON.parse(await f.tools.get('search_document').execute({ query: 'word', documentGeneration: 4, source: snapshot.source }))).toMatchObject({ status: 'unavailable' });
});

it('rejects old-source intent dispatched by name to a replacement registry with the same generation', async () => {
  const tools = new Map<string, any>();
  const api = { registerTool: (tool: any) => { tools.set(tool.name, tool); }, unregisterTool: (name: string) => { tools.delete(name); } };
  const host = { ensureVisible: async () => true, available: () => true };
  const oldSnapshot = { ...snapshot, documentGeneration: 1 };
  const oldBridge = new LiveReaderTools(api, host);
  oldBridge.attach({ snapshot: () => oldSnapshot, search: async () => { throw Error('unused'); }, navigate: async () => true });
  const inspected = JSON.parse(await tools.get('inspect_review').execute({}));
  const queued = { page: 2, documentGeneration: inspected.documentGeneration, source: inspected.source };
  oldBridge.dispose();
  const replacement = new LiveReaderTools(api, host);
  let moves = 0;
  replacement.attach({ snapshot: () => ({ ...oldSnapshot, source: { fileId: 'other-file', digest: 'other-digest' } }), search: async () => { throw Error('unused'); }, navigate: async () => { moves++; return true; } });
  expect(JSON.parse(await tools.get('navigate_page').execute(queued))).toMatchObject({ status: 'unavailable', reason: 'stale-source' });
  expect(moves).toBe(0);
});

it.each([
  ['search_document', { query: 'word' }],
  ['navigate_page', { page: 2 }],
  ['reveal_search_result', { resultId: 'same-result-id' }],
  ['reveal_annotation', { annotationId: 'same-annotation-id' }],
])('fences %s against missing, malformed, and changed source identity before dispatch', async (name, args) => {
  const f = fixture(); let calls = 0;
  f.bridge.attach({ snapshot: () => ({ ...snapshot, annotations: [{ id: 'same-annotation-id', page: 1, kind: 'note', text: '' }] }), search: async () => { calls++; throw Error('must not dispatch'); }, navigate: async () => { calls++; return true; } });
  for (const source of [undefined, {}, { fileId: 'x'.repeat(4097), digest: 'd' }, { fileId: 'f', digest: 'x'.repeat(513) }, { ...snapshot.source, grant: 'extra' }]) {
    expect(JSON.parse(await f.tools.get(name).execute({ ...args, documentGeneration: 4, source }))).toMatchObject({ status: 'unavailable', reason: 'invalid-source' });
  }
  for (const source of [{ ...snapshot.source, fileId: 'other' }, { ...snapshot.source, digest: 'other' }]) {
    expect(JSON.parse(await f.tools.get(name).execute({ ...args, documentGeneration: 4, source }))).toMatchObject({ status: 'unavailable', reason: 'stale-source' });
  }
  expect(calls).toBe(0);
});

it.each(['navigate_page', 'search_document'])('does not acknowledge %s after source changes at the same generation while pending', async name => {
  const f = fixture(); let current = snapshot;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  f.bridge.attach({ snapshot: () => current, navigate: async () => { await gate; return true; }, search: async () => { await gate; return { documentGeneration: 4, status: 'no-results', coverage: { totalPages: 3, searchedPages: 3, unsearchablePages: [], limitedPages: [] }, results: [], totalResults: 0, truncated: false, message: '' }; } });
  const pending = f.tools.get(name).execute({ page: 2, query: 'word', documentGeneration: 4, source: snapshot.source });
  await Promise.resolve(); await Promise.resolve();
  current = { ...snapshot, source: { ...snapshot.source, digest: 'changed-bytes' } }; finish();
  expect(JSON.parse(await pending)).toMatchObject({ status: 'unavailable' });
});

it('returns source with exact search results and passes the query unchanged', async () => {
  const f = fixture(); let received: string | undefined;
  const result = { documentGeneration: 4, status: 'partial' as const, coverage: { totalPages: 3, searchedPages: 2, unsearchablePages: [3], limitedPages: [] }, results: [{ id: 'match', page: 2, excerpt: 'word', matchKind: 'exact' as const }], totalResults: 1, truncated: false, message: 'partial' };
  f.bridge.attach({ snapshot: () => snapshot, navigate: async () => true, search: async query => { received = query; return result; } });
  const query = '  equilibrium α  ';
  expect(JSON.parse(await f.tools.get('search_document').execute({ query, documentGeneration: 4, source: snapshot.source }))).toEqual({ ...result, source: snapshot.source });
  expect(received).toBe(query);
  expect(f.tools.get('inspect_review').inputSchema.required).toEqual([]);
});
