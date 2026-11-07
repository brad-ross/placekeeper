import { expect, test, type Page } from '@playwright/test';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { extensionReader } from '../support/extension-reader.js';
import { extensionRecoveryReader } from '../support/extension-recovery-reader.js';

for (const scenario of [
  { width: 1120, theme: 'light', keyboard: true },
  { width: 375, theme: 'dark', keyboard: false },
] as const) test(`toolbox document context in the ${scenario.theme} ${scenario.width}px reader`, async ({ page }, info) => {
  await page.setViewportSize({ width: scenario.width, height: 800 });
  if (!scenario.keyboard) await page.emulateMedia({ reducedMotion: 'reduce' });
  const fixture = 'text-native.pdf';
  const reader = await extensionReader(page, fixture, {
    theme: scenario.theme,
    documentPublication: scenario.keyboard ? 'hold-first' : 'hold-and-decline-first',
  });
  try {
    await reader.ready();
    const bot = page.locator('[data-review-context-status] button[data-document-context]');
    const icon = bot.locator('svg');
    const tooltip = page.getByRole('tooltip');
    const documentPublications = () => page.evaluate(() =>
      (window as any).extensionAcceptance.documentPublications.map((pdfs: any[]) => pdfs.map(pdf => pdf.resource.blob)));
    await expect(page.locator('html')).toHaveAttribute('data-theme', scenario.theme);
    if (scenario.theme === 'dark') await expect(page.locator('#root')).toHaveCSS('color-scheme', 'dark');
    await expect(bot).toBeVisible();
    await expect(bot).toHaveAttribute('data-document-context', 'idle');
    await expect(bot).toHaveAccessibleName('Put document in context');
    const idle = await bot.boundingBox();
    expect(idle).toMatchObject({ width: 32, height: 32 });
    expect(idle!.x).toBeGreaterThanOrEqual(0);
    expect(idle!.x + idle!.width).toBeLessThanOrEqual(scenario.width);
    expect(await documentPublications()).toEqual([]);

    if (scenario.keyboard) {
      // Reach the bot using keyboard input so the shared focus tooltip opens.
      for (let step = 0; step < 12; step += 1) {
        await page.keyboard.press('Tab');
        if (await bot.evaluate(element => document.activeElement === element)) break;
      }
      await expect(bot).toBeFocused();
      await expect(tooltip).toHaveText('Put document in context');
      await page.keyboard.press('Enter');
      await expect(tooltip).toHaveText('Putting document in context…');
    } else {
      await bot.click();
    }

    await expect(bot).toHaveAttribute('data-document-context', 'publishing');
    await expect(bot).toHaveAttribute('aria-disabled', 'true');
    expect(await bot.boundingBox()).toEqual(idle);
    await expect(icon).toHaveCSS('animation-name', scenario.keyboard ? 'review-save-pulse' : 'none');
    await expect(icon).toHaveCSS('color', 'rgb(217, 173, 43)');
    await expect.poll(async () => (await documentPublications()).length).toBe(1);
    await bot.press('Enter');
    await page.evaluate(() => (window as any).extensionAcceptance.releaseDocumentPublication());

    if (!scenario.keyboard) {
      await expect(bot).toHaveAttribute('data-document-context', 'unavailable');
      await expect(bot).toHaveAccessibleName(/Document not in context.*Try again/u);
      await page.mouse.move(0, 0);
      await bot.hover();
      await expect(tooltip).toHaveText(/Document not in context.*Try again/u);
      await expect(icon).toHaveCSS('color', 'rgb(154, 61, 52)');
      expect(await bot.boundingBox()).toEqual(idle);
      await bot.click();
    }
    await expect(bot).toHaveAttribute('data-document-context', 'available');
    if (scenario.keyboard) {
      await expect(bot).toBeFocused();
    } else {
      await page.mouse.move(0, 0);
      await bot.hover();
    }
    await expect(tooltip).toHaveText('Document in context');
    await expect(icon).toHaveCSS('color', 'rgb(45, 104, 77)');
    const screenshot = info.outputPath(`document-context-${scenario.theme}-${scenario.width}.png`);
    await page.screenshot({ path: screenshot });
    await info.attach('accepted document context', { path: screenshot, contentType: 'image/png' });
    expect(await bot.boundingBox()).toEqual(idle);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width + 1);
    const pdf = (await readFile(`test/fixtures/pdfs/${fixture}`)).toString('base64');
    expect(await documentPublications()).toEqual(scenario.keyboard ? [[pdf]] : [[pdf], [pdf]]);
    expect(await page.evaluate(() => {
      const { messages, promptText } = (window as any).extensionAcceptance;
      return { messages, promptText };
    })).toEqual({ messages: [], promptText: 'Keep my typed question' });
  } finally { await reader.dispose(); }
});

test('toolbox document context waits for the replacement PDF receipt', async ({ page }) => {
  const reader = await extensionReader(page, 'text-native.pdf', { documentPublication: 'hold-second' });
  try {
    await reader.ready();
    const bot = page.locator('[data-review-context-status] button[data-document-context]');
    const before = await reader.tool('inspect_review', {});
    await bot.click();
    await expect(bot).toHaveAttribute('data-document-context', 'available');

    const replacement = await readFile('test/fixtures/pdfs/multi-page-text.pdf');
    const { bridge } = reader;
    await writeFile(`${bridge.pdfPath}.next`, replacement);
    await rename(`${bridge.pdfPath}.next`, bridge.pdfPath);
    await bridge.broker.replaceLiveDocument({
      sessionId: bridge.sessionId, outputPath: bridge.pdfPath, observationEpoch: before.documentGeneration,
    });
    await expect.poll(() => bridge.broker.state(bridge.sessionId)?.workflow.documentGeneration).toBe(before.documentGeneration + 1);
    await expect.poll(async () => (await reader.tool('inspect_review', {})).documentGeneration).toBe(before.documentGeneration + 1);
    const after = await reader.tool('inspect_review', {});
    expect(after.source.fileId).toBe(before.source.fileId);
    expect(after.source.digest).not.toBe(before.source.digest);
    await reader.ready();

    // The replacement is rendered and its complete PDF submitted, but the host has not accepted it.
    await expect.poll(() => page.evaluate(() => {
      const { documentPublications } = (window as any).extensionAcceptance;
      return documentPublications[1]?.map((pdf: any) => pdf.resource.blob);
    })).toEqual([replacement.toString('base64')]);
    await expect(bot).toHaveAttribute('data-document-context', 'publishing');
    await expect(bot.locator('svg')).toHaveCSS('color', 'rgb(217, 173, 43)');
    await page.evaluate(() => (window as any).extensionAcceptance.releaseDocumentPublication());
    await expect(bot).toHaveAttribute('data-document-context', 'available');
    await expect(bot.locator('svg')).toHaveCSS('color', 'rgb(45, 104, 77)');
  } finally { await reader.dispose(); }
});

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
for (const width of [1120, 375]) test(`reopening recovers a disconnected review at ${width}px without manual close`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 800 });
  const reader = await extensionRecoveryReader(page);
  try {
    await reader.mount(false); await reader.ready();
    const before = await reader.tool('inspect_review', {});
    expect(await reader.tool('navigate_page', { page: 2, documentGeneration: before.documentGeneration, source: before.source })).toMatchObject({ status: 'navigated', page: 2 });
    await expect.poll(async () => (await reader.manager.dispatch({ action: 'recent-list' }) as any).items[0]?.page).toBe(2);
    // Emulate a host that disappears before its cleanup request can arrive.
    reader.suppressRelease(true);
    await page.goto('about:blank');
    await reader.mount(true);
    await expect(page.getByText('Include review context', { exact: true })).toHaveCount(0);
    await page.locator('.extension-recent-card').hover();
    await page.getByRole('button', { name: 'Resume Recent paper.pdf', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Still open elsewhere. Try Resume again shortly.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close review', exact: true })).toHaveCount(0);
    const bounds = await page.locator('.extension-recent-card').boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await info.attach(`recovery-${width}px`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    reader.advance(30001);
    reader.suppressRelease(false);
    await page.locator('.extension-recent-card').hover();
    await page.getByRole('button', { name: 'Resume Recent paper.pdf', exact: true }).click();
    await reader.ready();
    await expect.poll(async () => (await reader.tool('inspect_review', {})).page).toBe(2);
    expect((await reader.tool('inspect_review', {})).source).toEqual(before.source);
    expect(await page.evaluate(() => (window as any).recoveryAcceptance.messages)).toEqual([]);
  } finally { await reader.dispose(); }
});

test('leaving the reader releases ownership without a Close review button', async ({ page }) => {
  const reader = await extensionRecoveryReader(page);
  try {
    await reader.mount(false); await reader.ready();
    await page.goto('about:blank');
    await expect.poll(() => reader.requests.some(request => request.action === 'revoke')).toBe(true);
    await reader.mount(true);
    await page.locator('.extension-recent-card').hover();
    await page.getByRole('button', { name: 'Resume Recent paper.pdf', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await reader.ready();
  } finally { await reader.dispose(); }
});

test('recent document Open Copy opens a separate review without a recovery dialog', async ({ page }) => {
  const reader = await extensionRecoveryReader(page);
  try {
    await reader.mount(false); await reader.ready();
    reader.suppressRelease(true);
    await page.goto('about:blank');
    await reader.mount(true);
    await page.locator('.extension-recent-card').hover();
    await page.getByRole('button', { name: 'Open copy of Recent paper.pdf', exact: true }).click();
    await reader.ready();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(reader.requests.some(request => request.action === 'choose' && request.choice === 'fork')).toBe(true);
    await expect.poll(async () => (await reader.manager.dispatch({ action: 'recent-list' }) as any).items.length).toBe(2);
    reader.suppressRelease(false);
  } finally { await reader.dispose(); }
});

test('extension bot attaches annotation notes without editing the prompt and respects context removal', async ({ page }, info) => {
  info.setTimeout(60_000);
  const reader = await extensionReader(page);
  try {
    await reader.ready();
    await expect.poll(() => page.evaluate(() => (window as any).extensionAcceptance.publications.length)).toBeGreaterThan(0);
    expect(reader.requests).not.toContain('settings-read');
    expect(reader.requests).not.toContain('catalogue');
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
    expect(await reader.tool('navigate_page', { page: 1, documentGeneration: 1, source: snapshot.source })).toMatchObject({ status: 'navigated' });
    await expect.poll(() => page.evaluate(uri => (window as any).extensionAcceptance.context.content.some((b: any) => b.resource.uri === uri), removed)).toBe(false);
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
    await expect(page.locator('.extension-menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Close review', exact: true })).toHaveCount(0);
    await expect(page.locator('.review-discussion-actions')).toHaveCount(0);
    const initial=await page.locator('#root').boundingBox();expect(initial!.y).toBeLessThan(2);
    await page.getByRole('button', { name: 'Show Workspace', exact: true }).click({ trial: true });
    await info.attach(`extension-${width}px-reader`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
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
    await expect.poll(() => page.evaluate(text => (window as any).extensionAcceptance.context?.content?.some((block: any) => block.resource.uri.endsWith('/background') && block.resource.text.includes(text)), snapshot.selection.text)).toBe(true);
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

test('removing host context cancels a pending automatic publication without exposing settings', async ({ page }) => {
  const reader = await extensionReader(page, 'text-native-with-annotations.pdf', { holdPublication: true });
  try {
    await reader.ready();
    await expect.poll(() => page.evaluate(() => (window as any).extensionAcceptance.preflightStarted)).toBeGreaterThan(0);
    await page.evaluate(() => {
      const state = (window as any).extensionAcceptance;
      state.context = null;
      state.shell.hostContextChanged({ 'openai/modelContext': null });
      state.releasePublication();
    });
    await expect.poll(() => page.evaluate(() => (window as any).extensionAcceptance.preflightFinished)).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).extensionAcceptance.publications.some((p: any) => p.content.length > 0))).toBe(false);
    await expect(page.locator('.extension-menu')).toHaveCount(0);
    expect(await reader.tool('inspect_review', {})).toMatchObject({ status: 'current', documentGeneration: 1 });
  } finally { await reader.dispose(); }
});

for (const width of [1120, 375]) test(`Resume keeps a calm loading surface until the reader is ready at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 800 });
  const reader = await extensionRecoveryReader(page);
  let release: (() => void) | undefined;
  try {
    await reader.mount(false); await reader.ready();
    await page.evaluate(() => (window as any).recoveryAcceptance.shell.teardown());
    await reader.mount(true);
    release = reader.holdBootstrap();
    await page.locator('.extension-recent-card').hover();
    await page.getByRole('button', { name: 'Resume Recent paper.pdf', exact: true }).click();
    const loading = page.getByRole('status', { name: 'Opening document', exact: true });
    await expect(loading).toBeVisible();
    await expect(page.locator('#root')).toHaveCSS('visibility', 'hidden');
    await expect(page.locator('#status')).toBeHidden();
    await expect(loading.locator('.document-loading__content')).toHaveCSS('opacity', '1');
    await expect.poll(() => loading.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    })).toEqual({ width, height: 800 });
    await info.attach(`resume-loading-${width}px`, { body: await page.screenshot(), contentType: 'image/png' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(loading.locator('.document-loading__indicator')).toHaveCSS('animation-name', 'none');
    release(); release = undefined;
    await reader.ready();
    await expect(loading).toHaveCount(0);
    await expect(page.locator('#root')).toHaveCSS('visibility', 'visible');
    await expect(page.locator('#status')).toBeHidden();
  } finally { release?.(); await reader.dispose(); }
});
