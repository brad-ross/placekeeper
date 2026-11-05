import { expect, it, vi } from 'vitest';
import { prepareReviewDraft, publishReviewDraft } from '../src/review-drafts.js';
const snapshot = () => ({ documentGeneration: 1, reviewRevision: 3, title: 'First PDF', source: { fileId: '/private/a.pdf', digest: 'original' }, page: 2, pageCount: 4, selection: { text: 'original selection', pages: [2] }, annotations: [{ id: 'a', page: 3, kind: 'note', text: 'original note' }] });
it('captures source, selection and chosen annotations before asynchronous work', async () => {
 const s = snapshot(); const draft = prepareReviewDraft({ kind: 'annotations', snapshot: s, annotationIds: ['a'] });
 s.annotations[0]!.text = 'revised'; s.annotations.length = 0; s.source.digest = 'new'; s.title = 'Second PDF';
 const send = vi.fn(async (_params: any) => ({})); const attach = vi.fn();
 await publishReviewDraft(draft, { send } as any, attach);
 expect(attach.mock.calls[0]![0].text).toContain('original note'); expect(draft.text).toContain('original'); expect(draft.text).not.toContain('/private');
 expect(send.mock.calls[0]![0]).toMatchObject({ role: 'user', _meta: { 'openai/message': { target: 'active', send: false } } });
 expect(draft.text).toContain('Page 3'); expect(draft.title).toContain('First PDF');
});
it('never sends when editable draft support is absent or fails; leaves copyable text', async () => {
 const draft = prepareReviewDraft({ kind: 'selection', snapshot: snapshot() }); const attach = vi.fn();
 expect(await publishReviewDraft(draft, undefined, attach)).toBe(false); expect(attach).not.toHaveBeenCalled();
 const send = vi.fn(async () => { throw Error('unavailable'); }); expect(await publishReviewDraft(draft, { send } as any, attach)).toBe(false);
 expect(send).toHaveBeenCalledOnce(); expect(draft.text).toContain('original selection');
});

it('retains the full copyable draft when the SDK resolves an error result', async () => {
 const s = snapshot(); s.selection.text = 'complete evidence '.repeat(600);
 const draft = prepareReviewDraft({ kind: 'selection', snapshot: s });
 const send = vi.fn(async (_params: any) => ({ isError: true }));
 expect(await publishReviewDraft(draft, { send } as any, vi.fn())).toBe(false);
 expect(draft.text).toContain(s.selection.text);
 expect(send).toHaveBeenCalledOnce();
 expect(send.mock.calls[0]![0]._meta['openai/message'].send).toBe(false);
});
