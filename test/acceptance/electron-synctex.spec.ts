import { copyFile, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { InstalledCandidate } from './electron-installed-harness.js';
import { discoverSyncTexToolDirectory } from '../support/electron-synctex-tools.js';
import { readWindowState } from '../../apps/electron/src/window-state.js';

const fixture = resolve('test/support/electron-synctex-fixture');
const syncTexToolDirectory = discoverSyncTexToolDirectory();
const requireSyncTex = process.env.REQUIRE_SYNCTEX_ACCEPTANCE === '1';
type NavigationState = { status: string; sequence?: number; generation?: number };
declare global {
  interface Window { installedSyncTexEvidence: { states: NavigationState[]; generations: number[] } }
}

async function prepare(candidate: InstalledCandidate) {
  const source = join(await realpath(candidate.root), 'Source with spaces.tex');
  const sidecar = candidate.source.replace(/\.pdf$/u, '.synctex');
  const record = join(candidate.root, 'editor-deliveries.jsonl');
  await copyFile(join(fixture, 'main.tex'), source);
  await copyFile(join(fixture, 'baseline.pdf'), candidate.source);
  const publishMapping = async (version: 'baseline' | 'rebuilt') => {
    const contents = (await readFile(join(fixture, `${version}.synctex`), 'utf8')).replace('PLACEKEEPER_FIXTURE_SOURCE', source);
    const temporary = `${sidecar}.next`;
    await writeFile(temporary, contents);
    await rename(temporary, sidecar);
  };
  return { source, sidecar, record, publishMapping };
}

async function register(candidate: InstalledCandidate, source: string, record: string) {
  // The adapter is a real executable process, with argv passed separately by the service.
  await candidate.command(['editor', 'add', '--name', 'acceptance-recorder', '--executable', process.execPath,
    '--args-json', JSON.stringify([join(fixture, 'record-editor.cjs'), record, '{file}', '{line}', '{column}'])]);
  return (await candidate.command(['editor', 'register', '--profile', 'acceptance-recorder', '--source-root', dirname(source)])).trim();
}

async function observe(page: Page) {
  await expect(page.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready', 'true', { timeout: 30_000 });
  await page.evaluate(() => {
    window.installedSyncTexEvidence = { states: [], generations: [] };
    window.placekeeper.subscribe(value => {
      const event = value as { event?: string; payload?: { command?: string; state?: NavigationState; generation?: number } };
      if (event.event === 'host-command' && event.payload?.command === 'source-navigation' && event.payload.state)
        window.installedSyncTexEvidence.states.push(event.payload.state);
      if (event.event === 'session-invalidated' && typeof event.payload?.generation === 'number')
        window.installedSyncTexEvidence.generations.push(event.payload.generation);
    });
  });
}

async function forward(candidate: InstalledCandidate, session: string, source: string, line: number) {
  const association = (await candidate.command(['forward-search', '--pdf', candidate.source, '--source', source,
    '--line', String(line), '--column', '1', '--session', session])).trim();
  expect(association).toMatch(/^[A-Za-z0-9_-]+$/u);
}

async function applied(page: Page, after = 0): Promise<number> {
  // Observe the real main-process poll after the renderer's acknowledgement. Never send an ack from the test.
  await expect.poll(() => page.evaluate(after => window.installedSyncTexEvidence.states.some(state =>
    state.status === 'applied' && (state.sequence ?? 0) > after), after), { timeout: 30_000 }).toBe(true);
  return page.evaluate(after => window.installedSyncTexEvidence.states.find(state =>
    state.status === 'applied' && (state.sequence ?? 0) > after)!.sequence!, after);
}

async function currentPage(page: Page, value: number) {
  await expect(page.getByRole('textbox', { name: /^Current page \d+ of 2\./u })).toHaveValue(String(value), { timeout: 30_000 });
}

async function sameReader(candidate: InstalledCandidate, page: Page, identity: { windowId: string; attemptId: string; presentation?: { zoom: number } }) {
  expect(await page.evaluate(() => window.placekeeper.identity())).toMatchObject({
    windowId: identity.windowId, attemptId: identity.attemptId,
  });
  expect(identity.presentation?.zoom).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(async () => (await window.placekeeper.identity()).presentation?.zoom)).toBe(identity.presentation?.zoom);
  expect(candidate.pages().filter(candidatePage => candidatePage.url().startsWith('placekeeper-app:'))).toHaveLength(1);
}

test.describe('installed Electron editor-command SyncTeX', () => {
  test.skip(!syncTexToolDirectory && !requireSyncTex, 'Requires the real SyncTeX query executable; committed PDFs need no LaTeX compiler.');
  test.beforeAll(() => {
    expect(syncTexToolDirectory, 'REQUIRE_SYNCTEX_ACCEPTANCE=1 requires a working real synctex query tool on PATH (or /Library/TeX/texbin).').toBeTruthy();
  });

  test('real CLI adopts an ordinary PDF window, acknowledges repeated forward jumps, and dispatches inverse search to an editor adapter process', async () => {
    test.setTimeout(120_000);
    const candidate = await InstalledCandidate.create();
    try {
      const files = await prepare(candidate);
      await files.publishMapping('baseline');
      const page = await candidate.launch({ toolDirectories: syncTexToolDirectory ? [syncTexToolDirectory] : [] });
      await observe(page);
      await currentPage(page, 1);
      const identity = await page.evaluate(() => window.placekeeper.identity());
      const session = await register(candidate, files.source, files.record);
      await forward(candidate, session, files.source, 6);
      await currentPage(page, 2);
      const first = await applied(page);
      await sameReader(candidate, page, identity);
      await forward(candidate, session, files.source, 4);
      await currentPage(page, 1);
      const second = await applied(page, first);
      await forward(candidate, session, files.source, 6);
      await currentPage(page, 2);
      await applied(page, second);
      await sameReader(candidate, page, identity);

      // A real user-facing inverse gesture, at the typeset line on page 2.
      // PDF dimensions are 612 x 792 pt; SyncTeX reports the line at (179, 135).
      const pdfPage = page.locator('.pdf-workspace__page[data-page-index="1"]');
      await pdfPage.scrollIntoViewIfNeeded();
      const bounds = await pdfPage.boundingBox();
      expect(bounds).not.toBeNull();
      await pdfPage.click({ position: { x: bounds!.width * 179 / 612, y: bounds!.height * 135 / 792 },
        modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
      await expect.poll(async () => {
        try { return (await readFile(files.record, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      }, { timeout: 15_000 }).toEqual([expect.objectContaining({ file: files.source, line: 6, column: 1, pid: expect.any(Number) })]);
      await sameReader(candidate, page, identity);
      expect(candidate.errors).toEqual([]);
    } finally { await candidate.dispose(); }
  });

  test('missing mapping and a rebuilt PDF with a delayed sidecar resume the latest explicit jump in the same reader', async () => {
    test.setTimeout(150_000);
    const candidate = await InstalledCandidate.create();
    try {
      const files = await prepare(candidate);
      const page = await candidate.launch({ toolDirectories: syncTexToolDirectory ? [syncTexToolDirectory] : [] });
      await observe(page);
      const identity = await page.evaluate(() => window.placekeeper.identity());
      const session = await register(candidate, files.source, files.record);
      await forward(candidate, session, files.source, 6);
      await expect.poll(() => page.evaluate(() => window.installedSyncTexEvidence.states.some(state => state.status === 'pending'))).toBe(true);
      await currentPage(page, 1);
      await files.publishMapping('baseline');
      await currentPage(page, 2);
      const first = await applied(page);

      // Establish page 1 before publishing a different genuine PDF generation.
      await forward(candidate, session, files.source, 4);
      await currentPage(page, 1);
      const second = await applied(page, first);
      await rm(files.sidecar);
      const revisedSource = (await readFile(join(fixture, 'main.tex'), 'utf8')).replace('Second page acceptance destination.', 'Second page rebuilt acceptance destination.');
      await writeFile(files.source, revisedSource);
      const replacement = `${candidate.source}.next`;
      await copyFile(join(fixture, 'rebuilt.pdf'), replacement);
      await rename(replacement, candidate.source);
      await expect.poll(() => page.evaluate(() => window.installedSyncTexEvidence.generations.some(generation => generation > 1)), { timeout: 30_000 }).toBe(true);
      await currentPage(page, 1);
      await forward(candidate, session, files.source, 4);
      await forward(candidate, session, files.source, 6);
      await expect.poll(() => page.evaluate(after => window.installedSyncTexEvidence.states.some(state =>
        state.status === 'pending' && (state.sequence ?? 0) > after + 1), second)).toBe(true);
      await currentPage(page, 1);
      await files.publishMapping('rebuilt');
      await currentPage(page, 2);
      const delivered = await applied(page, second);
      expect(delivered).toBe(second + 2);
      await expect.poll(() => page.evaluate(sequence => window.installedSyncTexEvidence.states.some(state =>
        state.status === 'ready' && state.sequence === sequence && (state.generation ?? 0) > 1), delivered)).toBe(true);
      await sameReader(candidate, page, identity);
      expect(candidate.errors).toEqual([]);
    } finally { await candidate.dispose(); }
  });

  test('cold CLI launch reaches renderer-persisted page 2, then page 1 in the same app process without a debugging endpoint', async ({}, testInfo) => {
    test.setTimeout(150_000);
    const candidate = await InstalledCandidate.create();
    try {
      const files = await prepare(candidate);
      await files.publishMapping('baseline');
      await candidate.prepareColdCommand(syncTexToolDirectory ? [syncTexToolDirectory] : []);
      expect(await candidate.ownedColdAppPids()).toEqual([]);
      const statePath = join(candidate.root, 'electron-user-data', 'windows.json');
      expect(await readWindowState(statePath)).toEqual([]);
      const session = await register(candidate, files.source, files.record);
      expect(await candidate.ownedColdAppPids()).toEqual([]);
      await forward(candidate, session, files.source, 6);

      // This is production renderer-presentation evidence, not a screenshot or a
      // direct acknowledgement assertion. Only review:presentation IPC supplies
      // these page/zoom values to the production windows.json persistence path.
      const sourcePath = await realpath(candidate.source);
      await expect.poll(() => readWindowState(statePath), { timeout: 60_000 }).toEqual([
        expect.objectContaining({ sourcePath, presentation: expect.objectContaining({ pageIndex: 1 }) }),
      ]);
      const first = (await readWindowState(statePath))[0]!;
      expect(first.presentation?.zoom).toBeGreaterThan(0);
      const pids = await candidate.ownedColdAppPids();
      expect(pids).toHaveLength(1);
      await forward(candidate, session, files.source, 4);
      await expect.poll(() => readWindowState(statePath), { timeout: 30_000 }).toEqual([
        expect.objectContaining({ sourcePath, presentation: { pageIndex: 0, zoom: first.presentation!.zoom } }),
      ]);
      expect(await candidate.ownedColdAppPids()).toEqual(pids);
      await testInfo.attach('cold-cli-renderer-presentation', { contentType: 'application/json', body: JSON.stringify({
        evidence: 'Production renderer-persisted presentation; no screenshot or direct acknowledgement observation',
        processIds: pids, first, afterSecondCommand: await readWindowState(statePath),
      }) });
    } finally { await candidate.dispose(); }
  });

});
