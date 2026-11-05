import { expect, it } from 'vitest';
import { LiveReaderTools } from '../src/live-reader-tools.js';
import type { ReviewAgentActions } from '../../web/src/host/review-agent-bridge.js';
const snapshot = { documentGeneration: 4, reviewRevision: 2, title: 'PDF', source: { fileId: 'file', digest: 'digest' }, page: 1, pageCount: 3, selection: null, annotations: [] };
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
  const pending = f.tools.get('navigate_page').execute({ page: 2, documentGeneration: 4 }).then((v: string) => { settled = true; return JSON.parse(v); });
  await Promise.resolve(); await Promise.resolve(); expect(f.moved()).toBe(true); expect(settled).toBe(false);
  f.finish(true); expect(await pending).toMatchObject({ status: 'navigated', documentGeneration: 4 });
});
it('rejects invalid pages, stale generations, missing annotations, and detached readers', async () => {
  const f = fixture();
  for (const args of [{ page: 0, documentGeneration: 4 }, { page: 4, documentGeneration: 4 }, { page: 2, documentGeneration: 3 }]) expect(JSON.parse(await f.tools.get('navigate_page').execute(args)).status).toBe('unavailable');
  expect(JSON.parse(await f.tools.get('reveal_annotation').execute({ annotationId: 'missing', documentGeneration: 4 })).status).toBe('unavailable');
  expect(f.moved()).toBe(false); f.detach();
  expect(JSON.parse(await f.tools.get('inspect_review').execute({})).status).toBe('unavailable');
  f.bridge.dispose(); expect(f.tools.size).toBe(0);
});
it('never acknowledges a reader detached while navigation is pending', async () => {
  const f = fixture(); const pending = f.tools.get('navigate_page').execute({ page: 2, documentGeneration: 4 });
  await Promise.resolve(); await Promise.resolve(); f.detach(); f.finish(true);
  expect(JSON.parse(await pending).status).toBe('unavailable');
});
it('reports an interrupted search without document content', async () => {
  const f = fixture(); expect(JSON.parse(await f.tools.get('search_document').execute({ query: 'word', documentGeneration: 4 }))).toMatchObject({ status: 'unavailable' });
});
