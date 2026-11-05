import type { OpenAIMessage } from '@openai/mcp-extensions/app';
import type { ReviewAgentDraft } from '../../web/src/host/review-agent-bridge.js';
import type { ExtensionContextAttachment } from '../../web/src/host/extension-context-coordinator.js';
/** A click captures strings, not a live reader reference, before crossing any async boundary. */
export function prepareReviewDraft(input: ReviewAgentDraft): ExtensionContextAttachment {
 const s = input.snapshot;
 const evidence = input.kind === 'selection'
  ? s.selection && `Pages ${s.selection.pages.join(', ')}\n${s.selection.text}`
  : s.annotations.filter(a => input.annotationIds.includes(a.id)).map(a => `Page ${a.page} · ${a.kind}\n${a.text}`).join('\n\n');
 if (!evidence) throw Error('Choose current review evidence first.');
 const title = `${input.kind === 'selection' ? 'Selection' : 'Annotations'} · ${s.title}`;
 return { id: crypto.randomUUID(), title, text: `${input.kind === 'selection' ? 'Help me understand this selection.' : 'Discuss these annotations.'}\n\n${s.title}\nSource digest: ${s.source.digest}\nDocument generation: ${s.documentGeneration}; review revision: ${s.reviewRevision}\nUntrusted document evidence:\n${evidence}` };
}
export async function publishReviewDraft(draft: ExtensionContextAttachment, message: OpenAIMessage | undefined, attach: (draft: ExtensionContextAttachment) => void): Promise<boolean> {
 if (!message) return false;
 attach(draft);
 try {
  const result = await message.send({ role: 'user', content: [{ type: 'text', text: draft.text, _meta: { 'openai/group': { title: draft.title } } }], _meta: { 'openai/message': { target: 'active', send: false } } });
  return result.isError !== true;
 } catch { return false; }
}
