import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { InstalledCandidate } from './electron-installed-harness.js';
import { REVIEW_RUNTIME_PROTOCOL, REVIEW_RUNTIME_VERSION } from '../../packages/core/src/review-runtime-protocol.js';

async function ready(page: Page): Promise<void> {
  await expect(page.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready', 'true', { timeout: 30_000 });
  await expect(page.locator('.pdf-workspace__page[data-page-index="0"] > img').first()).toBeVisible();
}

async function saveToOriginal(page: Page): Promise<void> {
  // The source is a disposable writable fixture. This uses the shared destination
  // dialog and real publisher without substituting a native save-dialog result.
  await page.getByRole('button', { name: /Open automatic save options$/u }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose where to save annotations' });
  await dialog.getByRole('radio', { name: 'Modify the original PDF' }).check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await saved(page);
}

async function saved(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /, Saved\. Open automatic save options$/u })).toBeVisible({ timeout: 30_000 });
}

async function openPageNote(page: Page) {
  const pdfPage = page.locator('.pdf-workspace:not(.pdf-workspace--reference) .pdf-workspace__page[data-page-index="0"]').first();
  const bounds = await pdfPage.boundingBox();
  if (!bounds) throw new Error('Rendered PDF page has no bounds');
  await pdfPage.click({ button: 'right', position: { x: bounds.width * 0.7, y: bounds.height * 0.55 } });
  await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
  const composer = page.getByRole('region', { name: /^Page Note(?: · 1)?$/u });
  await expect(composer).toBeVisible();
  return composer;
}

async function addPageNote(page: Page, text: string): Promise<void> {
  const composer = await openPageNote(page);
  await composer.getByRole('textbox', { name: 'Comment', exact: true }).fill(text);
  await composer.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(composer).toHaveCount(0);
}

test('canceling a protected page note without a save destination clears the draft and permits a new composer', async () => {
  test.setTimeout(90_000);
  const candidate = await InstalledCandidate.create('text-native.pdf');
  try {
    const original = await readFile(candidate.source);
    const page = await candidate.launch();
    await ready(page);
    // Bootstrap supplies only the diagnostic session identity. Authoring and
    // cancellation use the public UI; canonical recovery is read from disk.
    const sessionId = await page.evaluate(async ({ protocol, version }) => {
      const shell = window.placekeeper;
      const identity = await shell.identity();
      const bootstrap = await shell.request(identity, {
        protocol, version, kind: 'request', runtimeId: identity.windowId,
        requestId: crypto.randomUUID(), method: 'bootstrap', payload: {},
      }) as { sessionId: string };
      return bootstrap.sessionId;
    }, { protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION });
    const snapshot = async () => {
      const directory = join(candidate.root, 'recovery', sessionId);
      let contents: string;
      try { contents = await readFile(join(directory, 'draft.json'), 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // Publication rotates current to previous before publishing its
        // successor. Previous remains an acknowledged snapshot during that gap.
        // If both files are absent, this read still fails instead of inventing
        // an empty or successfully canceled review.
        contents = await readFile(join(directory, 'draft.previous.json'), 'utf8');
      }
      return JSON.parse(contents) as {
        payload: {
          state: { pendingDrafts: Array<{ text: string; status: string }>; items: unknown[] };
          destination: { phase: string };
        };
      };
    };
    const composer = await openPageNote(page);
    const text = 'Cancel this protected input without accepting an annotation.';
    await composer.getByRole('textbox', { name: 'Comment', exact: true }).fill(text);
    await expect(async () => {
      expect((await snapshot()).payload.state.pendingDrafts).toEqual([
        expect.objectContaining({ text, status: 'protected' }),
      ]);
    }).toPass({ timeout: 10_000 });
    expect((await snapshot()).payload.destination.phase).toBe('none');
    await composer.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(composer).toHaveCount(0);
    await expect.poll(async () => (await snapshot()).payload.state.pendingDrafts).toEqual([]);
    expect((await snapshot()).payload.state.items).toEqual([]);
    await expect(page.getByRole('dialog', { name: 'Choose where to save annotations' })).toHaveCount(0);
    expect(await readFile(candidate.source)).toEqual(original);
    const nextComposer = await openPageNote(page);
    await expect(nextComposer.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue('');
    await nextComposer.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(nextComposer).toHaveCount(0);
    await expect.poll(async () => (await snapshot()).payload.state.pendingDrafts).toEqual([]);
    expect((await snapshot()).payload.state.items).toEqual([]);
    expect(await readFile(candidate.source)).toEqual(original);
    expect(candidate.errors).toEqual([]);
  } finally { await candidate.dispose(); }
});

async function showAnnotations(page: Page): Promise<void> {
  const show = page.getByRole('button', { name: 'Show workspace', exact: true });
  if (await show.isVisible()) await show.click();
  await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
}

async function persistedComments(path: string): Promise<string[]> {
  const pdf = await PDFDocument.load(await readFile(path));
  return pdf.getPages().flatMap(page => {
    const annotations = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annotations) return [];
    return Array.from({ length: annotations.size() }, (_, index) => {
      const annotation = annotations.lookup(index, PDFDict);
      const contents = annotation.lookup(PDFName.of('Contents'));
      return contents instanceof PDFString || contents instanceof PDFHexString ? contents.decodeText() : '';
    });
  });
}

test('packaged review edits, undoes, redoes and saves a portable page note that reopens without recovery', async () => {
  test.setTimeout(120_000);
  const candidate = await InstalledCandidate.create('text-native.pdf');
  try {
    const page = await candidate.launch();
    await ready(page);
    await saveToOriginal(page);
    const initial = 'Created in the packaged desktop review.';
    const edited = 'Edited in the packaged desktop review.';
    await addPageNote(page, initial);
    await saved(page);
    await expect.poll(() => persistedComments(candidate.source)).toContain(initial);
    await showAnnotations(page);
    const row = page.locator('[data-review-item]').filter({ hasText: initial });
    await expect(row).toHaveCount(1);
    await row.hover();
    await row.getByRole('button', { name: 'Edit Page Note annotation on page 1' }).click();
    const editor = page.getByRole('region', { name: /^Edit Page Note/u });
    await editor.getByRole('textbox', { name: 'Comment', exact: true }).fill(edited);
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.locator('[data-review-item]')).toContainText(edited);
    await page.locator('[data-review-chrome]').hover();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.locator('[data-review-item]')).toContainText(initial);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(page.locator('[data-review-item]')).toContainText(edited);
    await saved(page);
    await expect.poll(() => persistedComments(candidate.source)).toContain(edited);
    expect(await persistedComments(candidate.source)).not.toContain(initial);

    // A distinct isolated root has no access to the first review's recovery.
    // Its annotation must therefore come from the published PDF itself.
    const portable = await InstalledCandidate.create('text-native.pdf');
    try {
      await copyFile(candidate.source, portable.source);
      const reopened = await portable.launch();
      await ready(reopened);
      await showAnnotations(reopened);
      await expect(reopened.locator('[data-review-item]')).toHaveCount(1);
      await expect(reopened.locator('[data-review-item]')).toContainText(edited);
      expect(portable.errors).toEqual([]);
    } finally { await portable.dispose(); }
    expect(candidate.errors).toEqual([]);
  } finally { await candidate.dispose(); }
});

test('packaged review observes an external PDF replacement and saves annotations into the successor document', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const candidate = await InstalledCandidate.create('text-native.pdf');
  let diagnosticPage: Page | undefined;
  try {
    const page = await candidate.launch();
    diagnosticPage = page;
    await ready(page);
    await saveToOriginal(page);
    await expect(page.getByRole('textbox', { name: 'Current page 1 of 1. Enter a page number', exact: true })).toBeVisible();
    // Record ownership before replacement so a failed Blob request can be
    // traced to its raster and revocation, rather than broadly ignored.
    await page.evaluate(() => {
      const events: unknown[] = [];
      const images = () => Array.from(document.images, image => ({
        src: image.currentSrc || image.src, complete: image.complete,
        width: image.naturalWidth, connected: image.isConnected,
      }));
      (window as Window & { refreshResourceEvents?: unknown[] }).refreshResourceEvents = events;
      events.push({ kind: 'before-replacement', images: images() });
      window.placekeeper.subscribe(message => events.push({ kind: 'runtime-event', message }));
      let previousUi = '';
      const observeUi = () => {
        const root = document.querySelector<HTMLElement>('[data-production-review]');
        const ui = {
          composer: document.querySelector('[data-comment-composer]') !== null,
          locationRestore: root?.dataset.locationRestoreStatus,
          initialReady: root?.dataset.initialViewReady,
          announcements: Array.from(document.querySelectorAll('[role="status"], [role="alert"], [aria-live]'), element => element.textContent),
        };
        const next = JSON.stringify(ui);
        if (next !== previousUi) { previousUi = next; events.push({ kind: 'ui', ...ui }); }
      };
      new MutationObserver(observeUi).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      observeUi();
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = object => {
        const url = create(object);
        events.push({ kind: 'create', url, type: object instanceof Blob ? object.type : 'MediaSource', stack: new Error().stack });
        return url;
      };
      URL.revokeObjectURL = url => {
        events.push({ kind: 'revoke', url, images: images(), stack: new Error().stack });
        revoke(url);
      };
      document.addEventListener('error', event => {
        if (event.target instanceof HTMLImageElement) events.push({ kind: 'image-error', src: event.target.currentSrc || event.target.src, images: images() });
      }, true);
    });
    const successor = await PDFDocument.load(await readFile(candidate.source));
    successor.addPage([612, 792]).drawText('Added by an external PDF producer.');
    successor.setSubject('Packaged desktop source refresh acceptance');
    await writeFile(candidate.source, await successor.save());
    await expect(page.getByRole('textbox', { name: 'Current page 1 of 2. Enter a page number', exact: true })).toBeVisible({ timeout: 30_000 });
    await ready(page);
    const comment = 'Saved after the external source refresh.';
    await addPageNote(page, comment);
    await saved(page);
    await expect.poll(() => persistedComments(candidate.source)).toContain(comment);
    const published = await PDFDocument.load(await readFile(candidate.source));
    expect(published.getPageCount()).toBe(2);
    expect(published.getSubject()).toBe('Packaged desktop source refresh acceptance');
    await showAnnotations(page);
    await expect(page.locator('[data-review-item]')).toContainText(comment);
    const currentRaster = page.locator('.pdf-workspace__page[data-page-index="0"] > img').first();
    await expect.poll(() => currentRaster.evaluate(async (image: HTMLImageElement) => {
      try { await image.decode(); return image.complete && image.naturalWidth > 0; }
      catch { return false; }
    })).toBe(true);
    expect(candidate.errors).toEqual([]);
  } finally {
    try {
      if (diagnosticPage && !diagnosticPage.isClosed()) {
        const lifetimePath = testInfo.outputPath('source-refresh-resource-lifetime.json');
        await writeFile(lifetimePath, JSON.stringify(await diagnosticPage.evaluate(() => ({
          events: (window as Window & { refreshResourceEvents?: unknown[] }).refreshResourceEvents,
          images: Array.from(document.images, image => ({ src: image.currentSrc || image.src, complete: image.complete, width: image.naturalWidth })),
          body: document.body.innerText,
        }))));
        await testInfo.attach('source-refresh-resource-lifetime', { path: lifetimePath, contentType: 'application/json' });
      }
    } finally { await candidate.dispose(); }
  }
});
