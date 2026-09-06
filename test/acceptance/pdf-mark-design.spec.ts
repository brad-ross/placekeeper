import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { PlacekeeperHost } from '../../apps/service/src/host/placekeeper-host.js';
import { addDelete, addHighlight, addInsert, addPageNote, addReplace, editReviewItem } from '../../packages/core/src/review-commands.js';
import type { ReviewSelectionAnchor } from '../../packages/core/src/review-commands.js';
import type { ReviewState } from '../../packages/core/src/review-model.js';

let root: string;
let host: PlacekeeperHost;
let sourceBytes: Uint8Array;
let phraseWidth: (text: string) => number;
const lines = [
  ['Local comparisons identify the effect.', 650],
  ['We hold market composition fixed.', 600],
  ['This necessarily implies an equilibrium.', 550],
  ['This implies a unique equilibrium.', 500],
  ['The effect is identified locally.', 450],
  ['Select this plain text to begin a new annotation.', 375],
] as const;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'placekeeper-pdf-mark-design-'));
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  phraseWidth = (text) => font.widthOfTextAtSize(text, 18);
  for (const rotation of [0, 90, 180, 270]) {
    const page = pdf.addPage([612, 792]);
    page.setRotation(degrees(rotation));
    page.drawText('Annotation design', { x: 72, y: 710, size: 24, font });
    for (const [text, y] of lines) page.drawText(text, { x: 72, y, size: 18, font });
  }
  sourceBytes = await pdf.save();
  host = await PlacekeeperHost.start({ recoveryRoot: join(root, 'recovery'), webAssets: { root: resolve('dist/web') } });
});
test.afterAll(async () => { await host?.close(); await rm(root, { recursive: true, force: true }); });

async function fixture(page: Page, pageIndex = 0) {
  const pdfPath = join(root, `${randomUUID()}.pdf`);
  await writeFile(pdfPath, sourceBytes);
  const launched = await host.open({ pdfPath, fork: true });
  if (!launched.ok || launched.kind === 'recovery-offered') throw new Error('PDF mark fixture failed');
  const current = () => host.broker.state(launched.sessionId)!;
  const anchor = (lineIndex: number, prefix: string, quote: string): ReviewSelectionAnchor => {
    const rect = { x: 72 + phraseWidth(prefix), y: 792 - lines[lineIndex]![1] - 14,
      width: phraseWidth(quote), height: 18 };
    return { pageIndex, quote, prefix, suffix: '', rect, segmentRects: [rect], reliable: true };
  };
  for (const command of [
    (state: ReviewState) => addHighlight(state, anchor(0, '', 'Local comparisons')),
    (state: ReviewState) => addHighlight(state, anchor(1, 'We hold ', 'market composition'), 'Which comparison group?'),
    (state: ReviewState) => addDelete(state, anchor(2, 'This ', 'necessarily')),
    (state: ReviewState) => addReplace(state, anchor(3, 'This implies ', 'a unique equilibrium.'), 'a local equilibrium.'),
    (state: ReviewState) => addInsert(state, { pageIndex,
      position: { x: 72 + phraseWidth('The effect is'), y: 792 - 450 - 14, width: 2, height: 18 },
      leftContext: 'The effect is', rightContext: ' identified locally.', reliable: true }, 'precisely '),
    (state: ReviewState) => addPageNote(state, pageIndex, { x: 535, y: 178, width: 18, height: 18 }, 'Connect this to Table 4.'),
  ]) await host.broker.acceptMutation(launched.sessionId, command(current()));
  await page.goto(launched.url);
  const pageInput = page.getByRole('textbox', { name: /^Current page/ });
  await expect(pageInput).toHaveValue('1');
  if (pageIndex !== 0) { await pageInput.fill(String(pageIndex + 1)); await pageInput.press('Enter'); }
  const pdfPage = page.locator(`.pdf-workspace:not(.pdf-workspace--reference) [data-page-index="${pageIndex}"]`);
  await expect(pdfPage.locator(':scope > img')).toBeVisible({ timeout: 15000 });
  await expect(pdfPage.locator('[data-owned-mark]')).toHaveCount(6);
  return { pdfPage, current, sessionId: launched.sessionId };
}

const paint = (mark: Locator) => mark.evaluate((element) => {
  const normal = getComputedStyle(element);
  const before = getComputedStyle(element, '::before');
  const after = getComputedStyle(element, '::after');
  return { background: normal.backgroundColor, outlineColor: normal.outlineColor,
    outlineStyle: normal.outlineStyle, outlineWidth: normal.outlineWidth,
    strike: before.content, strikeWidth: before.height, strikeColor: before.backgroundColor,
    underline: after.content, underlineWidth: after.height, underlineColor: after.backgroundColor,
    caretColor: after.borderTopColor, caretTransform: after.transform, animation: normal.animationName };
});

for (const [pageIndex, rotation] of [0, 90, 180, 270].entries()) {
  test(`PDF marks use semantic colors and follow the ${rotation}-degree text baseline`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 950 });
    const { pdfPage } = await fixture(page, pageIndex);
    const marks = pdfPage.locator('[data-owned-mark]');
    const highlight = pdfPage.locator('[data-owned-mark="highlight"][data-has-attached-text="false"]');
    const comment = pdfPage.locator('[data-owned-mark="highlight"][data-has-attached-text="true"]');
    const deletion = pdfPage.locator('[data-owned-mark="delete"]');
    const replacement = pdfPage.locator('[data-owned-mark="replace"]');
    const insertion = pdfPage.locator('[data-owned-mark="insert"]');
    await expect.poll(() => deletion.evaluate((element) => (element as HTMLElement).style.transform)).not.toContain('translateY(0px)');
    await expect.poll(() => replacement.evaluate((element) => (element as HTMLElement).style.transform)).not.toContain('translateY(0px)');
    expect(parseFloat(await replacement.evaluate((element) => (element as HTMLElement).style.getPropertyValue('--pdf-strike-position')))).toBeGreaterThan(50);
    await expect(highlight).toHaveCSS('background-color', 'rgba(245, 196, 35, 0.36)');
    expect((await paint(highlight)).underline).toBe('none');
    expect(await paint(comment)).toMatchObject({ underline: '""', underlineColor: 'rgb(177, 132, 13)' });
    expect(await paint(deletion)).toMatchObject({ strike: '""', strikeColor: 'rgb(195, 79, 84)', underline: 'none', background: 'rgba(0, 0, 0, 0)' });
    expect(await paint(replacement)).toMatchObject({ strike: '""', strikeColor: 'rgb(195, 79, 84)', underline: '""', underlineColor: 'rgb(195, 79, 84)', background: 'rgba(218, 78, 78, 0.2)' });
    expect(await paint(insertion)).toMatchObject({ animation: 'none', caretColor: 'rgb(94, 117, 136)', background: 'rgba(0, 0, 0, 0)' });
    await expect(pdfPage.locator('[data-owned-mark="pageNote"] .lucide-sticky-note')).toBeVisible();
    for (const mark of await marks.all()) {
      expect(await mark.evaluate((element) => (element as HTMLElement).style.transform)).toContain(`rotate(${rotation}deg)`);
    }
    await page.screenshot({ path: test.info().outputPath(`pdf-marks-${rotation}.png`) });
  });
}

test('marks preserve color through hover, activation, zoom, and comment removal', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 950 });
  const { pdfPage, current, sessionId } = await fixture(page);
  const comment = pdfPage.locator('[data-owned-mark="highlight"][data-has-attached-text="true"]');
  const itemId = (await comment.getAttribute('data-review-id'))!;
  const before = await paint(comment);
  const box = (await comment.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(comment).toHaveAttribute('data-corresponding', 'true');
  await expect(comment).toHaveCSS('background-color', 'rgba(245, 196, 35, 0.37)');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(comment).toHaveAttribute('data-active', 'true');
  await expect(comment).toHaveCSS('outline-color', 'rgb(150, 112, 6)');
  await page.mouse.move(0, 0);
  await expect(comment).toHaveCSS('background-color', before.background);
  const zoom = page.getByRole('textbox', { name: /^Current zoom/ });
  await zoom.fill('150'); await zoom.press('Enter');
  await expect(zoom).toHaveValue('150');
  const selected = pdfPage.locator(`[data-owned-mark][data-review-id="${itemId}"]`);
  await expect(selected).toHaveCSS('background-color', before.background);
  const originalBoxStyle = await selected.evaluate((element) => ({ height: (element as HTMLElement).style.height, transform: (element as HTMLElement).style.transform }));
  await host.broker.acceptMutation(sessionId, editReviewItem(current(), itemId, { comment: '' }));
  await expect(selected).toHaveAttribute('data-has-attached-text', 'false');
  expect(await selected.evaluate((element) => ({ height: (element as HTMLElement).style.height, transform: (element as HTMLElement).style.transform }))).toEqual(originalBoxStyle);
  expect((await paint(selected)).underline).toBe('none');
  await expect(selected).toHaveCSS('background-color', 'rgba(245, 196, 35, 0.36)');
});

test('the below-text insertion caret opens its detail without changing the PDF wording', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 950 });
  const { pdfPage } = await fixture(page);
  const insertion = pdfPage.locator('[data-owned-mark="insert"]');
  const box = (await insertion.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height + 2);
  await expect(insertion).toHaveAttribute('data-active', 'true');
  await expect(page.locator('[data-annotation-peek]')).toContainText('precisely');
  await expect(pdfPage.locator('[data-owned-annotation-layer]')).not.toContainText('precisely');
  const originalPixels = await pdfPage.locator(':scope > img').getAttribute('src');
  const replacement = pdfPage.locator('[data-owned-mark="replace"]');
  const replaceBox = (await replacement.boundingBox())!;
  await page.mouse.click(replaceBox.x + replaceBox.width / 2, replaceBox.y + replaceBox.height / 2);
  await expect(replacement).toHaveAttribute('data-active', 'true');
  await expect(page.locator('[data-annotation-peek]')).toContainText('a local equilibrium.');
  await expect(pdfPage.locator('[data-owned-annotation-layer]')).not.toContainText('a local equilibrium.');
  await expect(pdfPage.locator(':scope > img')).toHaveAttribute('src', originalPixels!);
});

test('text selection uses the shared blue wash and a plain I-beam', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 950 });
  const { pdfPage } = await fixture(page);
  const box = (await pdfPage.boundingBox())!;
  const scale = box.width / 612;
  const start = { x: box.x + 74 * scale, y: box.y + 411 * scale };
  await page.mouse.move(start.x, start.y);
  await expect.poll(() => page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return element ? getComputedStyle(element).cursor : null;
  }, start)).toBe('text');
  await page.mouse.down();
  await page.mouse.move(box.x + 246 * scale, start.y, { steps: 12 });
  const selection = pdfPage.locator(':scope > div[style*="mix-blend-mode"] > div').first();
  await expect(selection).toHaveCSS('background-color', 'rgb(207, 222, 234)');
  await page.mouse.up();
});

for (const zoomPercent of [50, 100, 200]) {
  test(`annotation strokes scale with PDF text at ${zoomPercent}% and hover meets the underline`, async ({ page }) => {
    const { pdfPage } = await fixture(page);
    const zoom = page.getByRole('textbox', { name: /^Current zoom/ });
    await zoom.fill(String(zoomPercent)); await zoom.press('Enter');
    await expect(zoom).toHaveValue(String(zoomPercent));
    const comment = pdfPage.locator('[data-owned-mark="highlight"][data-has-attached-text="true"]');
    const replacement = pdfPage.locator('[data-owned-mark="replace"]');
    await expect.poll(async () => parseFloat((await paint(comment)).underlineWidth)).toBeCloseTo(zoomPercent / 100, 2);
    expect(parseFloat((await paint(replacement)).strikeWidth)).toBeCloseTo(1.5 * zoomPercent / 100, 2);
    expect((await paint(replacement)).underlineWidth).toBe((await paint(comment)).underlineWidth);
    await comment.scrollIntoViewIfNeeded();
    const box = (await comment.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(comment).toHaveAttribute('data-corresponding', 'true');
    expect(parseFloat((await paint(comment)).outlineWidth)).toBeGreaterThanOrEqual(1);
    expect(parseFloat((await paint(comment)).outlineWidth)).toBeLessThanOrEqual(1.5);
    await expect.poll(async () => parseFloat((await paint(comment)).underlineWidth)).toBeCloseTo(1.25 * zoomPercent / 100, 2);
    await expect(comment).toHaveCSS('outline-offset', '0px');
    await expect(comment).toHaveCSS('border-radius', '3px');
    await expect(comment).toHaveCSS('overflow', 'hidden');
    await expect(comment).toHaveCSS('outline-color', (await paint(comment)).underlineColor);
    expect(await comment.evaluate((element) => getComputedStyle(element, '::after').bottom)).toBe('0px');
    const sharedStyle = (mark: Locator) => mark.evaluate((element) => {
      const box = getComputedStyle(element);
      const line = getComputedStyle(element, '::after');
      return { radius: box.borderRadius, overflow: box.overflow, outlineWidth: box.outlineWidth,
        outlineStyle: box.outlineStyle, outlineOffset: box.outlineOffset,
        underlineWidth: line.height, underlineBottom: line.bottom, blend: box.mixBlendMode };
    });
    const commentHover = await sharedStyle(comment);
    const replacementBox = (await replacement.boundingBox())!;
    await page.mouse.move(replacementBox.x + replacementBox.width / 2, replacementBox.y + replacementBox.height / 2);
    await expect(replacement).toHaveAttribute('data-corresponding', 'true');
    expect(await sharedStyle(replacement)).toEqual(commentHover);
    await page.mouse.click(replacementBox.x + replacementBox.width / 2, replacementBox.y + replacementBox.height / 2);
    await page.mouse.move(0, 0);
    await expect(replacement).toHaveAttribute('data-active', 'true');
    const replacementSelected = await sharedStyle(replacement);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(0, 0);
    await expect(comment).toHaveAttribute('data-active', 'true');
    expect(await sharedStyle(comment)).toEqual(replacementSelected);
    await page.screenshot({ path: test.info().outputPath(`stroke-zoom-${zoomPercent}.png`) });
  });
}

test('clicked PDF popup persists and discloses actions over its page number only on popup intent', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 950 });
  const { pdfPage } = await fixture(page);
  const mark = pdfPage.locator('[data-owned-mark="highlight"][data-has-attached-text="true"]');
  const box = (await mark.boundingBox())!;
  const peek = page.locator('[data-annotation-peek]');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(peek).toBeVisible();
  await expect(peek).toHaveAttribute('data-peek-selected', 'false');
  await expect.poll(() => page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, { x: box.x + box.width / 2, y: box.y + box.height / 2 })).toBe('pointer');
  await expect(peek.locator('.row-action-group')).toHaveCount(0);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(peek).toHaveAttribute('data-peek-selected', 'true');
  await expect(peek.getByRole('button', { name: /close/i })).toHaveCount(0);
  const actions = peek.locator('.row-action-group__direct');
  const number = peek.locator('.annotation-item__page');
  await page.mouse.move(0, 0);
  // Cross both hover dismissal and delayed-preview deadlines.
  await page.waitForTimeout(450);
  await expect(peek).toBeVisible();
  await expect(actions).toHaveCSS('opacity', '0');
  await expect(number).toHaveCSS('opacity', '1');
  await peek.hover();
  await expect(actions).toHaveCSS('opacity', '1');
  await expect(number).toHaveCSS('opacity', '0');
  const actionBox = (await actions.boundingBox())!;
  const numberBox = (await number.boundingBox())!;
  expect(actionBox.x + actionBox.width).toBeCloseTo(numberBox.x + numberBox.width, 0);
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS('opacity', '0');
  await expect(peek).toBeVisible();
  await peek.hover();
  await peek.getByRole('button', { name: 'Edit Highlight annotation on page 1' }).click();
  await expect(page.getByRole('region', { name: 'Edit Highlight', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(peek).toHaveAttribute('data-peek-selected', 'true');
  await expect(peek.getByRole('button', { name: 'Edit Highlight annotation on page 1' })).toBeFocused();
  await page.mouse.move(0, 0);
  await page.keyboard.press('Escape');
  await expect(peek).toHaveCount(0);
});


test('PDF hover gives the matching workspace card its normal hover appearance', async ({ page }) => {
  const { pdfPage } = await fixture(page);
  await page.getByRole('button', { name: 'Show workspace', exact: true }).click();
  await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
  const mark = pdfPage.locator('[data-owned-mark="highlight"][data-has-attached-text="true"]');
  const id = await mark.getAttribute('data-review-id');
  const row = page.locator(`[data-review-item="${id}"]`);
  await row.hover();
  const appearance = await row.evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, shadow: getComputedStyle(element).boxShadow }));
  const box = (await mark.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(row).toHaveAttribute('data-corresponding', 'true');
  expect(await row.evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, shadow: getComputedStyle(element).boxShadow }))).toEqual(appearance);
  await expect(row.locator('.row-action-group__direct')).toHaveCSS('opacity', '1');
  await expect(row.locator('.annotation-item__page')).toHaveCSS('opacity', '0');
  await expect(page.locator('[data-correspondence-direction]')).toHaveCount(0);
});


for (const width of [1280, 620]) {
  test(`hover preview avoids a non-annotation workspace at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    const { pdfPage } = await fixture(page);
    await page.getByRole('button', { name: 'Show workspace', exact: true }).click();
    await page.getByRole('tab', { name: 'Search', exact: true }).click();
    const mark = pdfPage.locator('[data-owned-mark="highlight"][data-has-attached-text="true"]');
    await mark.scrollIntoViewIfNeeded();
    const box = (await mark.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const peek = page.locator('[data-annotation-peek]');
    await expect(peek).toBeVisible();
    const tray = page.locator('[data-tools-workspace-open="true"], [data-workspace-open="true"]').filter({ visible: true }).first();
    const trayBox = (await tray.boundingBox())!;
    const edge = await page.locator('[data-review-stage]').evaluate((stage, vertical) => {
      const side = vertical ? 'right' : 'bottom';
      const fade = stage.querySelector(`.review-overlay-frame__${side}-fade`)!;
      const backing = stage.querySelector(`.review-overlay-frame__${side}-backing`)!;
      const fadeBox = fade.getBoundingClientRect();
      const backingBox = backing.getBoundingClientRect();
      return { size: vertical ? fadeBox.width : fadeBox.height,
        start: vertical ? backingBox.left : backingBox.top,
        end: vertical ? fadeBox.right : fadeBox.bottom,
        gradient: getComputedStyle(fade).backgroundImage,
        color: getComputedStyle(backing).backgroundColor };
    }, width > 700);
    expect(edge.size).toBe(12);
    expect(edge.end).toBeCloseTo(edge.start, 2);
    expect((width > 700 ? trayBox.x : trayBox.y) - edge.start).toBeCloseTo(12, 2);
    expect(edge.gradient).toContain('rgba(0, 0, 0, 0)');
    expect(edge.gradient).toContain(edge.color);

    const peekBox = (await peek.boundingBox())!;
    if (width > 700) expect(peekBox.x + peekBox.width).toBeCloseTo(trayBox.x - 12, 0);
    else expect(peekBox.y + peekBox.height).toBeCloseTo(trayBox.y - 12, 0);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByRole('tab', { name: 'Annotations', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(peek).toHaveCount(0);
  });
}
