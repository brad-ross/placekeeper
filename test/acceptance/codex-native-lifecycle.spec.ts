import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { SessionBroker } from '../../apps/service/src/sessions/session-broker.js';
import { nativeBridge } from '../support/codex-native-bridge.js';

// One semantic item and one Protected Draft carry the whole history. State is
// observed at each boundary; a final recovered DOM alone would miss false saves.
test('test MCP bridge composes protected work, delayed save, peer replacement, reattachment and fresh reopen', async ({ page, context }, info) => {
  info.setTimeout(90_000);
  const bridge = await nativeBridge('text-native.pdf');
  const peerPage = await context.newPage();
  let unblock: (() => void) | undefined;
  const trace: { stage: string; generation: number; revision: number; sync: unknown; itemIds: string[]; draftIds: string[] }[] = [];
  const observe = (stage: string) => {
    const state = bridge.broker.state(bridge.sessionId)!;
    trace.push({ stage, generation: state.workflow.documentGeneration, revision: state.revision,
      sync: bridge.broker.saveStatus(bridge.sessionId)?.sync, itemIds: state.items.map(item => item.id), draftIds: state.pendingDrafts.map(draft => draft.id) });
    return state;
  };
  try {
    const owner = await bridge.panel(page), peer = await bridge.panel(peerPage);
    await peerPage.getByRole('button', { name: 'Show workspace' }).click();
    await peerPage.getByRole('tab', { name: 'Annotations', exact: true }).click();
    await page.getByRole('button', { name: /Open automatic save options$/u }).click();
    const destination = page.getByRole('dialog', { name: 'Choose Where to Save Annotations' });
    await destination.getByRole('textbox', { name: 'Copy name' }).fill('reviewed.pdf');
    await destination.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(destination).toHaveCount(0); await bridge.saving.drain();
    expect(bridge.broker.saveStatus(bridge.sessionId)?.destination).toMatchObject({ kind: 'copy', phase: 'active' });
    const initialRevision = bridge.broker.state(bridge.sessionId)!.revision;
    const itemId = randomUUID(), draftId = randomUUID(), timestamp = '2026-10-05T12:00:00Z';
    const anchor = { kind: 'selection', pageIndex: 0, quote: 'unique equilibrium', prefix: '', suffix: '',
      rect: { x: 72, y: 88, width: 150, height: 14 }, segmentRects: [{ x: 72, y: 88, width: 150, height: 14 }] };
    const reached = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(); unblock = gate.resolve;
    bridge.setBeforeWrite(async () => { reached.resolve(); await gate.promise; });
    await owner.call('command', { type: 'add', expectedRevision: initialRevision, item: { id: itemId, kind: 'highlight', pageIndex: 0,
      createdAt: timestamp, updatedAt: timestamp, payload: { quote: anchor.quote, prefix: '', suffix: '', rect: anchor.rect, segmentRects: anchor.segmentRects, reliable: true, comment: 'Before refresh' } } });
    await reached.promise;
    await peer.call('command', { type: 'edit', expectedRevision: initialRevision + 1, id: itemId, updatedAt: timestamp, payload: { comment: 'Accepted while saving' } });
    await expect(peerPage.locator(`[data-review-item="${itemId}"]`)).toContainText('Accepted while saving');
    const savingState = observe('accepted-edit-saving');
    expect(savingState.items[0]?.id).toBe(itemId);
    expect(bridge.broker.saveStatus(bridge.sessionId)?.sync).toMatchObject({ phase: 'saving', desiredRevision: initialRevision + 2, savedRevision: initialRevision });
    const began = await owner.call('beginInteraction', { interactionToken: 'composed_editor_hold', order: 1, generation: 1 });
    await owner.call('command', { type: 'put-draft', expectedRevision: initialRevision + 2, expectedDraftRevision: -1,
      draft: { id: draftId, ownerViewId: began.ownerViewId, baseGeneration: 1, revision: 0, kind: 'highlight', pageIndex: 0,
        text: 'Protected through disconnect', anchor, disposition: { kind: 'resolved', generation: 1 }, status: 'protected', createdAt: timestamp, updatedAt: timestamp } });
    observe('protected-draft-held');
    const replacement = await PDFDocument.create(), font = await replacement.embedFont(StandardFonts.Helvetica);
    replacement.addPage([612, 792]).drawText('New reattachment target on the successor.', { x: 72, y: 690, size: 14, font });
    await writeFile(bridge.pdfPath, await replacement.save());
    expect(await bridge.broker.replaceLiveDocument({ sessionId: bridge.sessionId, outputPath: bridge.pdfPath, observationEpoch: 1 })).toMatchObject({ status: 'deferred' });
    expect(observe('replacement-deferred').workflow.documentGeneration).toBe(1);
    expect(bridge.broker.interactions.held(bridge.sessionId)).toBe(true);
    unblock(); bridge.setBeforeWrite(); await bridge.saving.drain();
    await owner.disconnect();
    await expect.poll(() => bridge.broker.state(bridge.sessionId)?.workflow.documentGeneration).toBe(2);
    const replaced = observe('replacement-after-disconnect');
    expect(replaced.pendingDrafts[0]).toMatchObject({ id: draftId, text: 'Protected through disconnect', status: 'frozen' });
    expect(replaced.items[0]?.id).toBe(itemId);
    expect(replaced.items[0]?.reconciliation?.disposition.kind).not.toBe('resolved');
    expect(bridge.broker.interactions.held(bridge.sessionId)).toBe(false);
    await expect(peerPage.locator('[data-reconciliation-entry]').first()).toBeVisible();
    await peer.call('watermark');
    const bootstrap = await peer.call('bootstrap');
    const item = (bootstrap.state as any).items.find((entry: any) => entry.id === itemId);
    await peer.call('command', { type: 'reattach', expectedRevision: replaced.revision, id: itemId,
      expectedReconciliationRevision: item.reconciliation.revision, ownerViewId: (bootstrap.interaction as any).attachmentId,
      anchor: { ...anchor, quote: 'New reattachment target', prefix: '', suffix: '' }, updatedAt: timestamp });
    const reattached = observe('manually-reattached');
    expect(reattached.items[0]?.reconciliation?.disposition.kind).toBe('resolved');
    expect(reattached.pendingDrafts[0]?.id).toBe(draftId);
    bridge.setBeforeWrite(async () => { throw new Error('Acceptance write failure'); });
    await peer.call('command', { type: 'edit', expectedRevision: reattached.revision, id: itemId, updatedAt: timestamp, payload: { comment: 'Recover this unsaved comment' } });
    await bridge.saving.drain();
    expect(bridge.broker.saveStatus(bridge.sessionId)?.sync.phase).toBe('not-saved'); observe('write-failed');
    await peer.disconnect();
    expect(await peer.raw('bootstrap')).toMatchObject({ status: 'denied' });
    const reopenedPage = await context.newPage();
    const reopened = await bridge.panel(reopenedPage);
    const restored = await reopened.call('bootstrap');
    expect((restored.state as any).items[0]).toMatchObject({ id: itemId, payload: { comment: 'Recover this unsaved comment' } });
    expect((restored.state as any).pendingDrafts[0].id).toBe(draftId);
    expect((restored.saveStatus as any).sync.phase).toBe('not-saved'); observe('fresh-panel-recovered');
    bridge.setBeforeWrite(); await reopened.call('retrySave'); await bridge.saving.drain();
    expect(bridge.broker.saveStatus(bridge.sessionId)?.sync).toMatchObject({ phase: 'clean', savedRevision: bridge.broker.state(bridge.sessionId)!.revision });
    expect((await PDFDocument.load(await readFile(join(bridge.root, 'reviewed.pdf')))).getPageCount()).toBe(1);
    // A separate recovery root cannot reuse this session's journal/snapshot.
    const portableBroker = new SessionBroker({ recoveryRoot: join(bridge.root, 'portable-recovery') });
    try {
      const portable = await portableBroker.openReview({ pdfPath: join(bridge.root, 'reviewed.pdf'), surface: 'codex-native' });
      if (portable.kind === 'recovery-offered') throw new Error('Portable PDF unexpectedly needed this review recovery');
      expect(portableBroker.state(portable.launch.sessionId)?.items[0]).toMatchObject({ id: itemId, payload: { comment: 'Recover this unsaved comment' } });
      expect(portableBroker.state(portable.launch.sessionId)?.pendingDrafts).toEqual([]);
    } finally { await portableBroker.quiesceForShutdown(); }
    observe('verified-save'); await reopened.disconnect();
    await info.attach('bridge-composed-lifecycle', { body: JSON.stringify({ actualHost: false, trace }), contentType: 'application/json' });
  } finally { unblock?.(); bridge.setBeforeWrite(); await bridge.dispose(); }
});

test('test MCP bridge isolates two chats, pending-save observations and obsolete evidence', async () => {
  const bridge = await nativeBridge('text-native.pdf');
  let unblock: (() => void) | undefined;
  try {
    const first = await bridge.panel();
    const otherPath = join(bridge.root, 'other.pdf');
    await writeFile(otherPath, await readFile('test/fixtures/pdfs/reference-navigation.pdf'));
    const opened = await bridge.broker.openReview({ pdfPath: otherPath, surface: 'codex-native' });
    if (opened.kind === 'recovery-offered') throw new Error('Unexpected recovery');
    const otherTask = `other-${randomUUID()}`;
    const second = await bridge.panel(undefined, { sessionId: opened.launch.sessionId, task: otherTask });
    const initial = await bridge.liveContext.refresh({ taskSessionId: bridge.task });
    const other = await bridge.liveContext.refresh({ taskSessionId: otherTask });
    expect(initial.status).toBe('current'); expect(other.status).toBe('current');
    if (initial.status !== 'current' || other.status !== 'current') throw new Error('Missing bound observations');
    expect(initial.identity.placekeeperSessionId).toBe(bridge.sessionId);
    expect(other.identity.placekeeperSessionId).toBe(opened.launch.sessionId);
    expect(initial.identity.source.digest).not.toBe(other.identity.source.digest);
    const handle = initial.evidence.handle.value;
    expect(await bridge.liveContext.evidence.retrieve({ taskSessionId: otherTask, handle, request: { kind: 'page-text', pageIndex: 0 } })).toMatchObject({ status: 'unavailable' });
    const conflict = bridge.manager.stageLaunch({ sessionId: bridge.sessionId, kind: 'opened' })!;
    expect(bridge.manager.claimLaunch({ bindProof: conflict.bindProof, reviewSessionId: bridge.sessionId, documentGeneration: 1, taskSessionId: otherTask })).toBe(false);
    await first.call('chooseCopy', { filename: 'chat-copy.pdf' }); await bridge.saving.drain();
    const gate = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>(); unblock = gate.resolve;
    bridge.setBeforeWrite(async () => { reached.resolve(); await gate.promise; });
    const revision = bridge.broker.state(bridge.sessionId)!.revision;
    await first.call('command', { type: 'add', expectedRevision: revision, item: { id: randomUUID(), kind: 'pageNote', pageIndex: 0,
      createdAt: '2026-10-05T12:00:00Z', updatedAt: '2026-10-05T12:00:00Z', payload: { comment: 'Discuss accepted unsaved work', position: { x: 1, y: 1, width: 20, height: 20 } } } });
    await reached.promise;
    const pending = await bridge.liveContext.refresh({ taskSessionId: bridge.task });
    expect(pending.status).toBe('current');
    if (pending.status !== 'current') throw new Error('Missing pending-save observation');
    expect(pending.identity.reviewRevision).toBe(revision + 1);
    expect(pending.saveStatus.sync).toMatchObject({ phase: 'saving', desiredRevision: revision + 1, savedRevision: revision });
    expect((await bridge.liveContext.refresh({ taskSessionId: otherTask })).status).toBe('current');
    expect(await bridge.liveContext.evidence.retrieve({ taskSessionId: bridge.task, handle, request: { kind: 'page-text', pageIndex: 0 } })).toMatchObject({ status: 'unavailable' });
    await first.disconnect();
    expect(await bridge.liveContext.refresh({ taskSessionId: bridge.task })).toMatchObject({ status: 'unavailable' });
    expect(await bridge.liveContext.refresh({ taskSessionId: otherTask })).toMatchObject({ status: 'current', identity: { placekeeperSessionId: opened.launch.sessionId } });
    expect(await first.raw('bootstrap')).toMatchObject({ status: 'denied' });
    unblock(); bridge.setBeforeWrite(); await bridge.saving.drain();
    await second.disconnect();
  } finally { unblock?.(); bridge.setBeforeWrite(); await bridge.dispose(); }
});

for (const editsExistingItem of [true, false]) {
  test(`mounted reattachment ${editsExistingItem ? 'retains the edited item identity' : 'creates an item for an untargeted draft'}`, async ({ page }) => {
    await page.route('**/reattachment-identity-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }));
    await page.goto('/reattachment-identity-test');
    await page.evaluate(async (editsExistingItem) => {
      const { ReconciliationWorkspace } = await import(/* @vite-ignore */ ('/apps/web/src/review/ReconciliationWorkspace.tsx' as string)) as typeof import('../../apps/web/src/review/ReconciliationWorkspace.js');
      const { createReviewState, canonicalizeReviewItem } = await import(/* @vite-ignore */ ('/packages/core/src/review-model.ts' as string)) as typeof import('../../packages/core/src/review-model.js');
      const { reduceReview } = await import(/* @vite-ignore */ ('/packages/core/src/review-reducer.ts' as string)) as typeof import('../../packages/core/src/review-reducer.js');
      const { default: { createElement } } = await import(/* @vite-ignore */ ('/@id/react' as string)) as { default: typeof import('react') };
      const { default: { createRoot } } = await import(/* @vite-ignore */ ('/@id/react-dom/client' as string)) as { default: typeof import('react-dom/client') };
      const itemId = '00000000-0000-4000-8000-000000000001', draftId = '00000000-0000-4000-8000-000000000002';
      const now = '2026-10-06T23:35:08.522Z';
      const anchor = { kind: 'selection' as const, pageIndex: 0, quote: 'old quote', prefix: '', suffix: '', rect: { x: 72, y: 92, width: 130, height: 12 }, segmentRects: [{ x: 72, y: 92, width: 130, height: 12 }] };
      const original = canonicalizeReviewItem({ id: itemId, kind: 'highlight', pageIndex: 0, createdAt: now, updatedAt: now, payload: { ...anchor, reliable: true, comment: 'Peer accepted edit' } }, { ownerViewId: 'peer', baseGeneration: 1 });
      let state = { ...createReviewState({ sessionId: 'identity-test', source: { fileId: 'source', digest: 'a'.repeat(64), byteLength: 10 }, documentGeneration: 2 }),
        items: editsExistingItem ? [{ ...original, reconciliation: { ...original.reconciliation!, disposition: { kind: 'missing' as const, reason: 'semantic-anchor-not-found' } } }] : [],
        pendingDrafts: [{ id: draftId, ownerViewId: 'disconnected-editor', baseGeneration: 1, revision: 27, kind: 'highlight' as const,
          ...(editsExistingItem ? { targetItemId: itemId } : {}), pageIndex: 0, text: 'Protected edit', anchor,
          disposition: { kind: 'missing' as const, reason: 'semantic-anchor-not-found' }, status: 'frozen' as const, createdAt: now, updatedAt: now }] };
      const commands: import('../../packages/core/src/review-model.js').ReviewCommand[] = [];
      const events: string[] = [];
      const mounted = createRoot(document.getElementById('root')!);
      const publish = () => { (window as unknown as { identityResult: unknown }).identityResult = { state, commands, events }; };
      const transport: import('../../apps/web/src/review/authoring-session.js').ReviewInteractionTransport = {
        async beginInteraction(input) { events.push('begin'); return { status: 'accepted', generation: input.generation, ownerViewId: 'fresh-editor' }; },
        async finalizeInteraction(input) {
          events.push('finalize');
          state = reduceReview(state, { type: 'apply-draft', expectedRevision: state.revision, id: input.draftId,
            expectedDraftRevision: input.expectedDraftRevision, ownerViewId: 'fresh-editor', updatedAt: now }) as typeof state;
          render(); publish();
          return { status: 'finalized', interactionToken: input.interactionToken, generation: 2, outcome: input.outcome, reviewRevision: state.revision };
        },
        async acknowledgeInteraction() { events.push('acknowledge'); publish(); return { status: 'released' }; },
        async releaseInteraction() { events.push('release'); publish(); return { status: 'released' }; },
      };
      function render() {
        mounted.render(createElement(ReconciliationWorkspace, { state, refreshStatus: 'idle',
          selectionUpdate: { kind: 'reliable', generation: 1, anchor: { ...anchor, quote: 'New reattachment target', reliable: true } },
          interactionLifecycle: transport, interactionLifecycleRequired: true,
          onCommand: async command => { commands.push(command); events.push(command.type); state = reduceReview(state, command) as typeof state; render(); publish(); return state; },
          renderSummary: summary => createElement('div', null, createElement('ul', null, summary.rows), summary.editor, summary.message),
        }));
      }
      render(); publish();
    }, editsExistingItem);
    await page.locator('[data-reconciliation-entry^="draft:"]').getByRole('button', { name: /Reattach previous/ }).click();
    await page.getByRole('button', { name: 'Attach', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { identityResult: { events: string[] } }).identityResult.events)).toEqual(['begin', 'put-draft', 'finalize', 'acknowledge']);
    const result = await page.evaluate(() => (window as unknown as { identityResult: { state: import('../../packages/core/src/review-model.js').ReviewState; commands: import('../../packages/core/src/review-model.js').ReviewCommand[] } }).identityResult);
    expect(result.state.pendingDrafts).toEqual([]);
    expect(result.state.items).toHaveLength(1);
    expect(result.state.items[0]).toMatchObject({ id: editsExistingItem ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002', payload: { quote: 'New reattachment target', comment: 'Protected edit' }, reconciliation: { disposition: { kind: 'resolved', generation: 2 } } });
    const put = result.commands[0]!;
    expect(put.type).toBe('put-draft');
    if (put.type === 'put-draft') expect(put.draft.targetItemId).toBe(editsExistingItem ? '00000000-0000-4000-8000-000000000001' : undefined);
  });
}
