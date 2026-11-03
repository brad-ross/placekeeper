import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test, type Page } from '@playwright/test';
import { InstalledCandidate, candidateExecutable } from './electron-installed-harness.js';
import budget from './electron-performance-budget.json' with { type: 'json' };

async function hash(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

function distribution(samples: number[]) {
  if (!samples.length || samples.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid timing samples');
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: samples.length, minMs: sorted[0], medianMs: sorted[Math.ceil(sorted.length * .5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1), samplesMs: samples };
}

async function ready(page: Page) {
  await expect(page.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready', 'true', { timeout: 30_000 });
  await page.locator('.pdf-workspace__page > img').first().evaluate(async (image: HTMLImageElement) => {
    await image.decode();
    await new Promise<void>(accept => requestAnimationFrame(() => requestAnimationFrame(() => accept())));
  });
}

// These are renderer frame opportunities, not compositor presentation timestamps.
async function startFrames(page: Page) {
  await page.evaluate(() => {
    const state = { times: [] as number[], running: true, visibility: [document.visibilityState] as string[] };
    (window as Window & { measurementFrames?: typeof state }).measurementFrames = state;
    const frame = (time: number) => { if (state.running) { state.times.push(time); state.visibility.push(document.visibilityState); requestAnimationFrame(frame); } };
    requestAnimationFrame(frame);
  });
}

async function stopFrames(page: Page) {
  return page.evaluate(() => {
    const state = (window as Window & { measurementFrames?: { times: number[]; running: boolean; visibility: string[] } }).measurementFrames!;
    state.running = false;
    return { intervalsMs: state.times.slice(1).map((value, index) => value - state.times[index]!),
      allVisible: state.visibility.every(value => value === 'visible'), durationMs: state.times.at(-1)! - state.times[0]! };
  });
}

test('targeted renderer responsiveness observations in an isolated packaged app', async ({}, info) => {
  test.setTimeout(180_000);
  const executable = candidateExecutable();
  const resources = process.platform === 'darwin' ? resolve(dirname(executable), '../Resources') : join(dirname(executable), 'resources');
  const artifactPaths = { executable, asar: join(resources, 'app.asar'), manifest: join(resources, 'desktop/runtime-manifest.json'), evidence: join(resources, 'desktop/build-evidence.json'), service: join(resources, 'desktop/service/main.js') };
  const rendererRoot = join(resources, 'desktop/electron-web');
  const rendererFiles = (await readdir(rendererRoot, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
  const artifactHashes = async () => ({
    ...Object.fromEntries(await Promise.all(Object.entries(artifactPaths).map(async ([name, path]) => [name, await hash(path)]))),
    renderer: Object.fromEntries(await Promise.all(rendererFiles.map(async path => [path.slice(rendererRoot.length + 1), await hash(path)]))),
  });
  const report: Record<string, unknown> = {
    status: 'incomplete', recordedAt: new Date().toISOString(), executable, artifactHashesBefore: await artifactHashes(),
    fixture: { path: 'test/fixtures/pdfs/large-text-heavy.pdf', sha256: await hash(resolve('test/fixtures/pdfs/large-text-heavy.pdf')) },
    host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model },
    budgets: budget,
    definitions: {
      observedShellUpperBound: 'Spawn to completed CDP screenshot after visible initial title/page-count chrome and two animation frames (before document readiness), with document.visibilityState recorded. Native window visibility is not observable through this Electron CDP endpoint. Includes harness connection/observation overhead; establishes an observed rendered shell, not the earliest native onscreen presentation.',
      shellProxy: 'Renderer first-contentful-paint epoch minus Node performance.timeOrigin + launchStartedAt (recorded immediately before spawn). FCP is renderer content paint, not proof of native window visibility or completed shell. Cross-process epoch alignment assumes no wall-clock step.',
      input: 'Trusted keydown timestamp to the second requestAnimationFrame after its matching input event; input value verified. Includes app input handling and a frame opportunity, excludes OS keyboard delivery before keydown and does not measure physical display presentation.',
      scroll: 'requestAnimationFrame intervals during forty alternating trusted CDP wheel inputs at nominal 100 ms spacing in the main scroll container; verify nonzero scroll displacement.',
      zoom: 'requestAnimationFrame intervals during twenty public zoom-percentage edits alternating 100/125 percent, submitted with Enter; verify the published zoom aria-label changed after each action. Includes control automation gaps; not PDF raster completion latency.',
    },
    limitations: [
      'Exploratory local observations only: three cold launches, one long-text fixture and one input/scroll/zoom session. This is not the required 20-launch matrix and does not qualify R12.',
      'Electron does not expose Browser.getWindowForTarget on this CDP endpoint. First native visible shell remains unmeasured. FCP is a separately named proxy and is not compared as a pass against the first-visible-shell target.',
      'rAF timestamps are main-thread frame opportunities; compositor/GPU presentation, screen scanout, visible glyph raster and OS input-to-photon latency are unmeasured.',
      'Foreground debuggable release app with CDP attached, ordinary shared desktop and uncontrolled filesystem caches. No AppKit comparison, representative large scan or long recovery workload.',
      'Existing targets are recorded unchanged; the test checks measurement validity, not a performance acceptance pass.',
    ],
  };
  const shell: unknown[] = [];
  let candidate: InstalledCandidate | undefined;
  try {
    for (let sample = 0; sample < 3; sample++) {
      candidate = await InstalledCandidate.create('large-text-heavy.pdf');
      const page = await candidate.launch();
      await page.bringToFront();
      await page.locator('[data-review-chrome]').waitFor({ state: 'visible', timeout: 30_000 });
      await page.evaluate(() => new Promise<void>(accept => requestAnimationFrame(() => requestAnimationFrame(() => accept()))));
      const shellScreenshotPath = info.outputPath(`observed-shell-${sample}.png`);
      await page.screenshot({ path: shellScreenshotPath });
      const observedShellUpperBoundMs = performance.now() - candidate.launchStartedAt;
      await ready(page);
      const paint = await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, paints: window.performance.getEntriesByType('paint').map(entry => ({ name: entry.name, startTime: entry.startTime })),
        visibility: document.visibilityState, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, screenWidth: screen.width, screenHeight: screen.height } }));
      const fcp = paint.paints.find(entry => entry.name === 'first-contentful-paint');
      if (!fcp) throw new Error('Packaged renderer supplied no FCP entry');
      const spawnEpochMs = performance.timeOrigin + candidate.launchStartedAt;
      const fcpFromSpawnMs = paint.timeOrigin + fcp.startTime - spawnEpochMs;
      expect(fcpFromSpawnMs).toBeGreaterThanOrEqual(0);
      shell.push({ sample, spawnEpochMs, ...paint, observedShellUpperBoundMs, shellScreenshotPath, rendererFcpFromSpawnMs: fcpFromSpawnMs, usableObservedFromSpawnMs: performance.now() - candidate.launchStartedAt, mainImportRelativeDiagnostics: candidate.timings() });
      report.shellProxySamples = shell;
      if (sample !== 2) { await candidate.dispose(); candidate = undefined; continue; }

      // Exercise a real protected authoring input rather than an unrelated test DOM.
      const pdfPage = page.locator('.pdf-workspace:not(.pdf-workspace--reference) .pdf-workspace__page[data-page-index="0"]').first();
      const bounds = await pdfPage.boundingBox();
      if (!bounds) throw new Error('PDF page has no bounds');
      await pdfPage.click({ button: 'right', position: { x: bounds.width * .7, y: Math.min(bounds.height * .4, 250) } });
      await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
      const composer = page.getByRole('region', { name: 'Page Note', exact: true });
      const input = composer.getByRole('textbox', { name: 'Comment', exact: true });
      await input.focus();
      await input.evaluate(element => {
        const samples: Array<{ key: string; startMs: number; elapsedMs: number; trusted: boolean; value: string }> = [];
        (window as Window & { measurementInput?: typeof samples }).measurementInput = samples;
        let key: { key: string; startMs: number; trusted: boolean } | undefined;
        element.addEventListener('keydown', event => { const e = event as KeyboardEvent; key = { key: e.key, startMs: performance.now(), trusted: e.isTrusted }; });
        element.addEventListener('input', event => {
          if (!key) return;
          const current = key; key = undefined;
          const value = (element as HTMLTextAreaElement).value;
          requestAnimationFrame(() => requestAnimationFrame(() => samples.push({ ...current, elapsedMs: performance.now() - current.startMs, trusted: current.trusted && event.isTrusted, value })));
        });
      });
      for (let i = 0; i < 40; i++) {
        await page.keyboard.type('a');
        await expect.poll(() => page.evaluate(() => (window as Window & { measurementInput?: unknown[] }).measurementInput!.length)).toBe(i + 1);
      }
      await expect(input).toHaveValue('a'.repeat(40));
      const inputs = await page.evaluate(() => (window as Window & { measurementInput?: Array<{ elapsedMs: number; trusted: boolean }> }).measurementInput!);
      expect(inputs.every(value => value.trusted)).toBe(true);
      report.input = { ...distribution(inputs.map(value => value.elapsedMs)), events: inputs };
      await composer.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(composer).toHaveCount(0);

      const scroll = await page.locator('.pdf-workspace:not(.pdf-workspace--reference)').evaluate(element => {
        const nodes = [element, ...Array.from(element.querySelectorAll('*'))];
        const node = nodes.find(value => value.scrollHeight > value.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(value).overflowY));
        if (!node) throw new Error('No main PDF scroll container');
        node.setAttribute('data-measurement-scroll', 'true');
        return { height: node.clientHeight, scrollHeight: node.scrollHeight };
      });
      const scrollNode = page.locator('[data-measurement-scroll]');
      await scrollNode.hover();
      const scrollPositions: number[] = [];
      await startFrames(page);
      for (let i = 0; i < 40; i++) {
        await page.mouse.wheel(0, i % 2 === 0 ? 180 : -180);
        await delay(100);
        scrollPositions.push(await scrollNode.evaluate(element => element.scrollTop));
      }
      const scrolling = await stopFrames(page);
      expect(scrolling.allVisible).toBe(true);
      expect(new Set(scrollPositions).size).toBeGreaterThan(1);
      report.scroll = { ...scroll, ...distribution(scrolling.intervalsMs), allVisible: scrolling.allVisible, durationMs: scrolling.durationMs, positions: scrollPositions };

      const zoom = page.getByRole('textbox', { name: /^Current zoom .*Enter a zoom percentage/u });
      const zoomValues: string[] = [];
      await startFrames(page);
      for (let i = 0; i < 20; i++) {
        const target = i % 2 === 0 ? '100' : '125';
        await zoom.fill(target);
        await zoom.press('Enter');
        await expect(zoom).toHaveAttribute('aria-label', `Current zoom ${target} percent. Enter a zoom percentage`);
        zoomValues.push(await zoom.inputValue());
        await delay(100);
      }
      const zooming = await stopFrames(page);
      expect(zooming.allVisible).toBe(true);
      report.zoom = { ...distribution(zooming.intervalsMs), allVisible: zooming.allVisible, durationMs: zooming.durationMs, values: zoomValues };
      report.screenshotPath = info.outputPath('responsiveness-final.png');
      await page.screenshot({ path: report.screenshotPath as string });
      expect(candidate.errors).toEqual([]);
    }
    report.status = 'observations-complete';
  } catch (error) {
    report.failure = String(error);
    throw error;
  } finally {
    try { await candidate?.dispose(); } finally {
      report.artifactHashesAfter = await artifactHashes();
      report.artifactUnchanged = JSON.stringify(report.artifactHashesBefore) === JSON.stringify(report.artifactHashesAfter);
      const path = info.outputPath('packaged-responsiveness-observations.json');
      await writeFile(path, JSON.stringify(report, null, 2));
      await info.attach('packaged-responsiveness-observations', { path, contentType: 'application/json' });
    }
  }
  expect(report.artifactUnchanged).toBe(true);
});
