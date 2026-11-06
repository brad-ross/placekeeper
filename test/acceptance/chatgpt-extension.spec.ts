import { expect, test, type Page } from '@playwright/test';
import { extensionReader } from '../support/extension-reader.js';
import { extensionRecoveryReader } from '../support/extension-recovery-reader.js';

async function openOptions(page: Page) {
  if (!await page.locator('.extension-menu').evaluate((element: HTMLDetailsElement) => element.open)) await page.locator('summary[aria-label="Review options"]').click();
}
async function openSharing(page: Page) {
  await openOptions(page);
  const summary = page.locator('#controls summary').filter({ hasText: /^Sharing settings$/ });
  if (!await summary.evaluate(element => (element.parentElement as HTMLDetailsElement).open)) await summary.click();
}
async function openAnnotationContext(page: Page, id: string) {
  const mark=page.locator(`[data-owned-native-geometry][data-review-id="${id}"], [data-owned-mark][data-review-id="${id}"]`).first();
  await mark.scrollIntoViewIfNeeded();
  const bounds=await mark.boundingBox();if(!bounds)throw Error('Annotation mark is not visible');
  await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
  const peek=page.locator(`[data-annotation-peek="${id}"]`);
  await expect(peek).toBeVisible();
  await peek.hover();
  await expect(peek.locator('[data-row-action="copy-link"]')).toHaveCount(0);
  await peek.locator('[data-row-action="add-context"]').click();
  await expect(page.getByRole('dialog',{name:'Add annotation to chat',exact:true})).toBeVisible();
}
test('recent review recovers a removed panel, restores its page, and attaches an included snapshot', async ({ page }, info) => {
  info.setTimeout(60000);
  const reader = await extensionRecoveryReader(page);
  try {
    await reader.mount(false); await reader.ready();
    const before = await reader.tool('inspect_review', {});
    expect(await reader.tool('navigate_page', { page: 2, documentGeneration: before.documentGeneration, source: before.source })).toMatchObject({ status: 'navigated', page: 2 });
    await expect.poll(async () => (await reader.manager.dispatch({ action: 'recent-list' }) as any).items[0]?.page).toBe(2);
    await openSharing(page);
    await page.getByRole('checkbox', { name: 'Allow explicitly included review snapshots in other chats', exact: true }).check();
    await page.getByRole('button', { name: 'Include this review snapshot', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Update included snapshot', exact: true })).toBeVisible();
    // Destroy the old document without invoking app teardown, as a cancelled host close does.
    await page.goto('about:blank'); reader.advance(30001);
    await reader.mount(true);
    await page.locator('summary').filter({ hasText: /^Include review context$/ }).click();
    await page.getByRole('button', { name: 'Include snapshot', exact: true }).first().click();
    await expect.poll(() => page.evaluate(() => (window as any).recoveryAcceptance.context?.content?.some((block: any) => block.resource.uri.includes('/attachment/')))).toBe(true);
    await expect(page.locator('[data-production-review]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Resume Recent paper.pdf', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Recover disconnected review', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Recover disconnected review', exact: true }).click();
    await reader.ready();
    await expect.poll(async () => (await reader.tool('inspect_review', {})).page).toBe(2);
    const after = await reader.tool('inspect_review', {});
    expect(after.source).toEqual(before.source);
    const activeSelection = await page.evaluate(() => {
      const state = (window as any).recoveryAcceptance;
      const uri = state.context.content.find((block: any) => block.resource.uri.includes('/attachment/')).resource.uri;
      state.context = { ...state.context, updateId: 'remove-chooser-attachment', content: state.context.content.filter((block: any) => block.resource.uri !== uri) };
      state.shell.hostContextChanged({ 'openai/modelContext': state.context });
      return { uri, publicationCount: state.publications.length };
    });
    await expect.poll(() => page.evaluate(uri => (window as any).recoveryAcceptance.context.content.some((block: any) => block.resource.uri === uri), activeSelection.uri)).toBe(false);
    await openOptions(page);
    await page.locator('summary').filter({ hasText: /^Include review context$/ }).click();
    await page.getByRole('button', { name: 'Include snapshot', exact: true }).first().click();
    await expect.poll(() => page.evaluate(({ uri, publicationCount }) => (window as any).recoveryAcceptance.publications.slice(publicationCount).some((publication: any) => publication.content.some((block: any) => block.resource.uri === uri)), activeSelection)).toBe(true);
    expect(await page.evaluate(() => (window as any).recoveryAcceptance.messages)).toEqual([]);
    const removed = await page.evaluate(() => {
      const state = (window as any).recoveryAcceptance;
      const removed = state.context.content.find((block: any) => block.resource.uri.includes('/attachment/')).resource.uri;
      state.context = { ...state.context, updateId: 'human-removal', content: state.context.content.filter((block: any) => block.resource.uri !== removed) };
      state.shell.hostContextChanged({ 'openai/modelContext': state.context });
      return removed;
    });
    expect(await reader.tool('navigate_page', { page: 1, documentGeneration: after.documentGeneration, source: after.source })).toMatchObject({ status: 'navigated' });
    await expect.poll(() => page.evaluate(uri => (window as any).recoveryAcceptance.context.content.some((block: any) => block.resource.uri === uri), removed)).toBe(false);
    await info.attach('recovery-and-context', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  } finally { await reader.dispose(); }
});

test('extension bot attaches annotation notes without editing the prompt and respects context removal', async ({ page }, info) => {
  info.setTimeout(60_000);
  const reader = await extensionReader(page);
  try {
    await expect(page.locator('[data-production-review]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).extensionAcceptance.publications)).toEqual([]);
    await reader.ready();
    await expect.poll(() => page.evaluate(() => (window as any).extensionAcceptance.publications.length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).extensionAcceptance.publications.every((p: any) => p.settingsLoaded))).toBe(true);
    const snapshot = await reader.tool('inspect_review', {});
    expect(snapshot).toMatchObject({ status: 'current', documentGeneration: 1 });
    expect(snapshot.annotations.map((a: any) => a.id)).toEqual(reader.bridge.broker.state(reader.bridge.sessionId)!.items.map(a => a.id));
    const search = await reader.tool('search_document', { query: 'equilibrium', documentGeneration: 1, source: snapshot.source });
    expect(search.results.length).toBeGreaterThan(0);
    const revealed = await reader.tool('reveal_search_result', { resultId: search.results[0].id, documentGeneration: 1, source: search.source });
    expect(revealed, JSON.stringify(revealed)).toMatchObject({ status: 'navigated', page: 1 });
    expect(await reader.tool('navigate_page', { page: 1, documentGeneration: 2, source: snapshot.source })).toMatchObject({ status: 'unavailable', reason: 'stale-generation' });
    await expect(page.locator('.review-discussion-actions')).toHaveCount(0);
    await openAnnotationContext(page, snapshot.annotations[0].id);
    const note=page.getByRole('textbox',{name:'Note (optional)',exact:true});
    await note.fill('Compare this annotation with the earlier result.');
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    expect(await page.evaluate(() => (window as any).extensionAcceptance.context.content.some((b:any)=>b.resource.uri.includes('/attachment/')))).toBe(false);
    await openAnnotationContext(page, snapshot.annotations[0].id);
    await expect(note).toHaveValue('Compare this annotation with the earlier result.');
    await page.getByRole('button',{name:'Add to chat',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).extensionAcceptance.context.content.filter((b:any)=>b.resource.uri.includes('/attachment/')).length)).toBe(1);
    const attachment=await page.evaluate(() => (window as any).extensionAcceptance.context.content.find((b:any)=>b.resource.uri.includes('/attachment/')));
    expect(attachment.resource.text).toContain(snapshot.annotations[0].text);expect(attachment.resource.text).toContain('Compare this annotation');
    await openAnnotationContext(page, snapshot.annotations[0].id);
    await note.fill('Updated note');await page.getByRole('button',{name:'Add to chat',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const updated=await page.evaluate(() => (window as any).extensionAcceptance.context.content.filter((b:any)=>b.resource.uri.includes('/attachment/')));
    expect(updated).toHaveLength(1);expect(updated[0].resource.uri).toBe(attachment.resource.uri);expect(updated[0].resource.text).toContain('Updated note');
    expect(await page.evaluate(() => (window as any).extensionAcceptance.messages)).toEqual([]);
    expect(await page.evaluate(() => (window as any).extensionAcceptance.promptText)).toBe('Keep my typed question');
    const removed = await page.evaluate(() => {
      const state = (window as any).extensionAcceptance;
      const removed = state.context.content.find((b: any) => b.resource.uri.includes('/attachment/')).resource.uri;
      state.context = { ...state.context, updateId: 'human-partial-removal', content: state.context.content.filter((b: any) => b.resource.uri !== removed) };
      state.shell.hostContextChanged({ 'openai/modelContext': state.context });
      return removed;
    });
    await openSharing(page);
    await page.getByRole('checkbox', { name: 'Share current selection in background context', exact: true }).uncheck();
    await expect.poll(() => page.evaluate(uri => (window as any).extensionAcceptance.context.content.some((b: any) => b.resource.uri === uri), removed)).toBe(false);
    await page.getByRole('checkbox', { name: 'Allow explicitly included review snapshots in other chats', exact: true }).check();
    await page.getByRole('button', { name: 'Include this review snapshot', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Update included snapshot', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Remove this review from mentions', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Include this review snapshot', exact: true })).toBeVisible();
    // Let the PDF viewer observe the inline layout before the tool expands it.
    await page.locator('[data-viewer-framing-viewport]').evaluate(viewport => new Promise<void>(resolve => {
      const observer = new ResizeObserver(entries => {
        if (entries[0]?.contentRect.width !== 0) return;
        observer.disconnect();
        requestAnimationFrame(() => resolve());
      });
      observer.observe(viewport);
      (window as any).extensionAcceptance.shell.hostContextChanged({ displayMode: 'inline' });
    }));
    await expect(page.locator('#root')).toBeHidden();
    expect(await reader.tool('navigate_page', { page: 1, documentGeneration: 1, source: snapshot.source })).toMatchObject({ status: 'navigated', page: 1 });
    await expect(page.locator('#root')).toBeVisible();
    expect(await page.evaluate(() => (window as any).extensionAcceptance.expansionRequests)).toBe(1);
    const supersededReveal = await page.locator('[data-viewer-framing-viewport]').evaluate(async (viewport: HTMLElement, { resultId, source }) => {
      const { tools } = (window as any).extensionAcceptance;
      const input = { documentGeneration: 1, source };
      const display = viewport.style.display;
      viewport.style.display = 'none';
      const reveal = tools.get('reveal_search_result').execute({ ...input, resultId });
      try {
        // Keep the reveal waiting for geometry until a new query supersedes it.
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const replacement = JSON.parse(await tools.get('search_document').execute({ ...input, query: 'unmatchedreplacementquery' }));
        if (replacement.results?.length !== 0) throw Error('Expected an empty replacement search');
      } finally {
        viewport.style.display = display;
      }
      return JSON.parse(await reveal);
    }, { resultId: search.results[0].id, source: search.source });
    expect(supersededReveal).toMatchObject({ status: 'unavailable', reason: 'stale-or-unavailable-result' });
    await info.attach('extension-boundary-evidence', { body: JSON.stringify({ actualHost: false, sessionId: reader.bridge.sessionId, generation: snapshot.documentGeneration, annotationIds: snapshot.annotations.map((a: any) => a.id), requests: reader.requests, promptUnchanged: true }), contentType: 'application/json' });
  } finally { await reader.dispose(); }
});

for (const width of [1440, 1120, 375]) test(`extension reader and bot note layout at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  const reader = await extensionReader(page);
  try {
    await reader.ready();
    await expect(page.locator('.extension-menu')).not.toHaveAttribute('open','');
    await expect(page.locator('.review-discussion-actions')).toHaveCount(0);
    const initial=await page.locator('#root').boundingBox();expect(initial!.y).toBeLessThan(2);
    await page.getByRole('button', { name: 'Show workspace', exact: true }).click({ trial: true });
    await info.attach(`extension-${width}px-reader`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await openSharing(page);
    await expect(page.getByRole('checkbox', { name: 'Share background review context', exact: true })).toBeVisible();
    const panel=await page.locator('.extension-menu__panel').boundingBox();expect(panel!.x).toBeGreaterThanOrEqual(0);expect(panel!.x+panel!.width).toBeLessThanOrEqual(width);
    await info.attach(`extension-${width}px-options`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await page.locator('summary[aria-label="Review options"]').click();
    const snapshot=await reader.tool('inspect_review',{});await openAnnotationContext(page,snapshot.annotations[0].id);
    await page.getByRole('textbox',{name:'Note (optional)',exact:true}).fill('Why does this matter?');
    const dialog=await page.getByRole('dialog').boundingBox();expect(dialog!.x).toBeGreaterThanOrEqual(0);expect(dialog!.x+dialog!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
    await info.attach(`extension-${width}px-note`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    expect(await page.evaluate(() => (window as any).extensionAcceptance.messages)).toEqual([]);
  } finally { await reader.dispose(); }
});

test('extension selection bot attaches a captured note without changing the prompt or PDF', async ({ page }) => {
  const reader = await extensionReader(page, 'text-native.pdf');
  try {
    await reader.ready();
    const zoom = page.getByRole('textbox', { name: /^Current zoom/ });
    await zoom.fill('100'); await zoom.press('Enter');
    await expect(zoom).toHaveValue('100');
    const pdf = page.locator('.pdf-workspace:not(.pdf-workspace--reference) [data-page-index="0"]').first();
    await expect.poll(async () => Math.round((await pdf.boundingBox())?.width ?? 0)).toBe(612);
    await page.locator('.pdf-workspace:not(.pdf-workspace--reference) .pdf-workspace__viewport').evaluate(element => { element.scrollTop = 0; });
    const box = await pdf.boundingBox(); if (!box) throw Error('Missing PDF page');
    await page.mouse.move(box.x + 76, box.y + 98); await page.mouse.down();
    await page.mouse.move(box.x + Math.min(455, box.width - 30), box.y + 105, { steps: 12 }); await page.mouse.up();
    await expect(page.getByRole('button', { name: 'Add selection to chat', exact: true })).toBeVisible();
    const snapshot = await reader.tool('inspect_review', {});
    expect(snapshot.selection.text.length).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Add selection to chat', exact: true }).click();
    await expect(page.getByRole('dialog',{name:'Add selection to chat',exact:true})).toBeVisible();
    await page.getByRole('textbox',{name:'Note (optional)',exact:true}).fill('Explain this passage.');
    await page.getByRole('button',{name:'Add to chat',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const attachment=await page.evaluate(() => (window as any).extensionAcceptance.context.content.find((b:any)=>b.resource.uri.includes('/attachment/')));
    expect(attachment.resource.text).toContain(snapshot.selection.text);expect(attachment.resource.text).toContain('Explain this passage.');
    expect(await page.evaluate(() => (window as any).extensionAcceptance.messages)).toEqual([]);
    expect(await page.evaluate(() => (window as any).extensionAcceptance.promptText)).toBe('Keep my typed question');
    expect(reader.bridge.broker.state(reader.bridge.sessionId)?.items).toEqual([]);
  } finally { await reader.dispose(); }
});

test('extension observes external sharing-off before a pending publication can reach the host', async ({ page }) => {
  const reader = await extensionReader(page);
  try {
    await page.evaluate(() => {
      const state = (window as any).extensionAcceptance;
      state.publicationGate = new Promise<void>(resolve => { state.releasePublication = resolve; });
    });
    await reader.ready();
    await openOptions(page);
    await expect(page.getByText('Attaching context…', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      const state = (window as any).extensionAcceptance;
      state.settings = { backgroundContext: false, selectionSharing: false, mentions: false }; state.revision++;
      state.shell.wake();
    });
    await openSharing(page);
    await expect(page.getByRole('checkbox', { name: 'Share background review context', exact: true })).not.toBeChecked();
    await page.evaluate(() => (window as any).extensionAcceptance.releasePublication());
    await expect(page.getByText('Background sharing paused', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).extensionAcceptance.publications.some((p: any) => p.content.length > 0))).toBe(false);
    expect(await reader.tool('inspect_review', {})).toMatchObject({ status: 'current', documentGeneration: 1 });
  } finally { await reader.dispose(); }
});
