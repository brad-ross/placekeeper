import { expect, it } from 'vitest';
import { prepareReviewContext } from '../src/review-context-attachment.js';
const snapshot = () => ({ documentGeneration: 1, reviewRevision: 3, title: 'First PDF', source: { fileId: '/private/a.pdf', digest: 'original' }, page: 2, pageCount: 4, selection: { text: 'original selection', pages: [2] }, annotations: [{ id: 'a', page: 3, kind: 'note', text: 'original note' }] });
it('captures chosen evidence and the user note without a prompt instruction or private path', async () => {
 const s=snapshot(); const pending=prepareReviewContext({kind:'annotations',snapshot:s,annotationIds:['a'],note:'Compare this with the earlier result.'});
 s.annotations[0]!.text='revised';s.source.digest='replacement';
 const attachment=await pending;const body=JSON.parse(attachment.text);
 expect(body).toMatchObject({userNote:'Compare this with the earlier result.',sourceDigest:'original',documentGeneration:1,reviewRevision:3,annotations:[{id:'a',page:3,text:'original note'}]});
 expect(attachment.text).not.toContain('/private');expect(attachment.text).not.toContain('Discuss these annotations');expect(attachment.title).toContain('Page 3');
});
it('updates the same captured subject when its note changes and separates different sources',async()=>{
 const input={kind:'selection' as const,snapshot:snapshot()};
 const first=await prepareReviewContext({...input,note:'First note'}), edited=await prepareReviewContext({...input,note:'Edited note'});
 expect(edited.id).toBe(first.id);expect(JSON.parse(edited.text).userNote).toBe('Edited note');
 const other=snapshot();other.source.digest='other';expect((await prepareReviewContext({kind:'selection',snapshot:other})).id).not.toBe(first.id);
});
it('bounds long evidence as valid JSON while retaining the user note and honest truncation',async()=>{
 const s=snapshot();s.selection.text='\\"'.repeat(20000);
 const attachment=await prepareReviewContext({kind:'selection',snapshot:s,note:'Please explain the middle section.'});
 const body=JSON.parse(attachment.text);expect(attachment.text.length).toBeLessThanOrEqual(6000);expect(body.userNote).toBe('Please explain the middle section.');expect(body.truncated).toBe(true);expect(body.selection.originalCharacters).toBe(s.selection.text.length);expect(attachment.text).not.toContain('draft');
});
it('rejects missing evidence and notes over the documented input limit',async()=>{
 await expect(prepareReviewContext({kind:'annotations',snapshot:snapshot(),annotationIds:['missing']})).rejects.toThrow();
 await expect(prepareReviewContext({kind:'selection',snapshot:snapshot(),note:'x'.repeat(2001)})).rejects.toThrow();
});
