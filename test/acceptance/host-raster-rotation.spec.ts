import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { expect, test } from '@playwright/test';

for (const resourceHost of ['codex', 'browser'] as const) {
  for (const intrinsicRotation of [0, 1, 2, 3]) {
    test(`${resourceHost} Main and References raster and text selection preserve crop and rotation ${intrinsicRotation * 90}`, async ({ page }) => {
      const fixture = await PDFDocument.create();
      const fixturePage = fixture.addPage([600, 800]);
      const font = await fixture.embedFont(StandardFonts.Helvetica);
      fixturePage.drawText('ROTATE', { x: 190, y: 355, size: 18, font, color: resourceHost === 'codex' ? rgb(1, 0, 0) : rgb(0, 0, 0) });
      fixturePage.setCropBox(40, 60, 400, 600);
      fixturePage.setRotation(degrees(intrinsicRotation * 90));
      // A green lower-left rectangle and a blue upper-right square distinguish
      // all four orientations. Coordinates are inside the nonzero crop origin.
      fixturePage.drawRectangle({ x: 60, y: 80, width: 80, height: 40, color: rgb(0, 1, 0) });
      fixturePage.drawRectangle({ x: 350, y: 530, width: 50, height: 50, color: rgb(0, 0, 1) });
      const [workerSource, wasm, css] = await Promise.all([
        readFile('dist/web/pdfium-codex-worker.js', 'utf8'),
        readFile('dist/web/pdfium.wasm'), readFile('dist/web/app.css', 'utf8'),
      ]);
      await page.route('**/raster-rotation-gate', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }));
      await page.goto('/raster-rotation-gate');
      await page.exposeFunction('selectRotationWord', async (point: { x: number; y: number }) => {
        await page.mouse.move(point.x, point.y);
        await page.mouse.dblclick(point.x, point.y);
      });
      await page.exposeFunction('captureSelectionPixels', async (clip: { x: number; y: number; width: number; height: number }) =>
        (await page.screenshot({ clip })).toString('base64'));
      const result = await page.evaluate(async ({ pdf, workerSource, wasm, css, resourceHost }) => {
        const { createLocalPdfiumViewer } = await import(/* @vite-ignore */ ('/apps/web/src/pdf/embedpdf-viewer.ts' as string)) as typeof import('../../apps/web/src/pdf/embedpdf-viewer.js');
        const { buildReferenceDocumentOptions } = await import(/* @vite-ignore */ ('/apps/web/src/pdf/reference-document.ts' as string)) as typeof import('../../apps/web/src/pdf/reference-document.js');
        const { PdfWorkspace } = await import(/* @vite-ignore */ ('/apps/web/src/pdf/PdfWorkspace.tsx' as string)) as typeof import('../../apps/web/src/pdf/PdfWorkspace.js');
        const { DocumentManagerPlugin } = await import(/* @vite-ignore */ ('/@id/@embedpdf/plugin-document-manager' as string)) as typeof import('@embedpdf/plugin-document-manager');
        const { SelectionPlugin } = await import(/* @vite-ignore */ ('/@id/@embedpdf/plugin-selection' as string)) as typeof import('@embedpdf/plugin-selection');
        const { transformRect } = await import(/* @vite-ignore */ ('/@id/@embedpdf/models' as string)) as typeof import('@embedpdf/models');
        const { setRotation } = await import(/* @vite-ignore */ ('/@id/@embedpdf/core' as string)) as typeof import('@embedpdf/core');
        const { MAIN_PDF_DOCUMENT_ID, REFERENCE_PDF_DOCUMENT_ID } = await import(/* @vite-ignore */ ('/apps/web/src/pdf/viewer-document-ids.ts' as string)) as typeof import('../../apps/web/src/pdf/viewer-document-ids.js');
        const { default: { createElement } } = await import(/* @vite-ignore */ ('/@id/react' as string)) as { default: typeof import('react') };
        const { default: { createRoot } } = await import(/* @vite-ignore */ ('/@id/react-dom/client' as string)) as { default: typeof import('react-dom/client') };
        const decode = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));
        const documentBytes = decode(pdf), pdfiumWasmBytes = decode(wasm);
        const resources = {
          document: URL.createObjectURL(new Blob([documentBytes], { type: 'application/pdf' })),
          pdfiumWasm: URL.createObjectURL(new Blob([pdfiumWasmBytes], { type: 'application/wasm' })),
          worker: URL.createObjectURL(new Blob([workerSource], { type: 'application/javascript' })),
        };
        // Both display policies use the same verified engine bytes, so this
        // isolates the actual host image boundary rather than different PDFs.
        const policy = { host: 'codex', resources } as const;
        const assets = { documentUrl: resources.document, pdfiumWasm: resources.pdfiumWasm, workerUrl: resources.worker, documentBytes, pdfiumWasmBytes };
        const { engine, plugins } = createLocalPdfiumViewer(assets, policy);
        const style = document.createElement('style'); style.textContent = css; document.head.append(style);
        const root = document.getElementById('root')!; root.dataset.productionRoot = 'true'; root.style.cssText = 'width:700px;height:700px';
        const referenceHost = document.createElement('div'); referenceHost.style.cssText = 'position:fixed;right:0;top:0;width:400px;height:650px'; document.body.append(referenceHost);
        referenceHost.style.setProperty('--review-pdf-selection-bg', getComputedStyle(root).getPropertyValue('--review-pdf-selection-bg'));
        const mounted = createRoot(root);
        let registry!: import('@embedpdf/core').PluginRegistry;
        let ready!: () => void;
        const initialized = new Promise<void>(resolve => { ready = resolve; });
        const searchResult = { id: 'green-marker', pageIndex: 0, charIndex: 0, charCount: 1, navigationPoint: { x: 60, y: 40 }, rects: [{ origin: { x: 20, y: 540 }, size: { width: 80, height: 40 } }], excerpt: 'marker', excerptMatch: { start: 0, length: 1 }, kind: 'exact', matchedForm: 'marker' } as const;
        mounted.render(createElement(PdfWorkspace, {
          engine, plugins, resourceHost, fillContainer: true, referenceViewportHost: referenceHost, referenceTabIdentity: 'rotation-gate', searchResults: [searchResult],
          onInitialized: async value => {
            registry = value;
            const manager = registry.getPlugin<InstanceType<typeof DocumentManagerPlugin>>(DocumentManagerPlugin.id)!.provides();
            const opened = await manager.openDocumentBuffer(buildReferenceDocumentOptions(assets, policy) as import('@embedpdf/plugin-document-manager').LoadDocumentBufferOptions).toPromise();
            await opened.task.toPromise(); ready();
          },
        }));
        const inspect = async (selector: string, previousSource?: string) => {
          const image = await new Promise<HTMLImageElement>(resolve => {
            const check = () => {
              const candidate = document.querySelector<HTMLImageElement>(selector);
              if (candidate?.src && candidate.src !== previousSource) resolve(candidate);
              else requestAnimationFrame(check);
            }; check();
          });
          await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          const centers = { green: { x: 0, y: 0, count: 0 }, blue: { x: 0, y: 0, count: 0 } };
          for (let index = 0; index < pixels.length; index += 4) {
            const color = pixels[index]! < 5 && pixels[index + 1]! > 250 && pixels[index + 2]! < 5 ? centers.green : pixels[index]! < 5 && pixels[index + 1]! < 5 && pixels[index + 2]! > 250 ? centers.blue : null;
            if (color) { const point = index / 4; color.x += point % canvas.width; color.y += Math.floor(point / canvas.width); color.count++; }
          }
          const bounds = image.getBoundingClientRect();
          const highlight = image.parentElement!.querySelector('[data-pdf-search-highlight="green-marker"]')?.getBoundingClientRect();
          return {
            source: image.src, width: canvas.width, height: canvas.height, displayWidth: bounds.width, displayHeight: bounds.height,
            green: { x: centers.green.x / centers.green.count / canvas.width, y: centers.green.y / centers.green.count / canvas.height },
            blue: { x: centers.blue.x / centers.blue.count / canvas.width, y: centers.blue.y / centers.blue.count / canvas.height },
            overlay: highlight ? { x: (highlight.x + highlight.width / 2 - bounds.x) / bounds.width, y: (highlight.y + highlight.height / 2 - bounds.y) / bounds.height } : null,
          };
        };
        const inspectSelection = async (selector: string, documentId: string) => {
          const image = document.querySelector<HTMLImageElement>(selector)!;
          const pdfDocument = registry.getStore().getState().core.documents[documentId]!.document!;
          const pdfPage = pdfDocument.pages[0]!;
          const scope = registry.getPlugin<InstanceType<typeof SelectionPlugin>>(SelectionPlugin.id)!.provides().forDocument(documentId);
          await new Promise<void>(resolve => {
            const check = () => scope.getState().geometry[0] ? resolve() : requestAnimationFrame(check);
            check();
          });
          const word = (await engine.getPageTextRects(pdfDocument, pdfPage).toPromise()).find(rect => rect.content.includes('ROTATE'));
          if (!word) throw new Error('Real engine word geometry missing');
          const state = registry.getStore().getState().core.documents[documentId]!;
          const rotation = ((pdfPage.rotation + state.rotation) % 4) as import('@embedpdf/models').Rotation;
          const display = image.getBoundingClientRect();
          const scale = display.width / (rotation % 2 ? pdfPage.size.height : pdfPage.size.width);
          const located = transformRect(pdfPage.size, word.rect, rotation, scale);
          await (window as unknown as { selectRotationWord(point: { x: number; y: number }): Promise<void> }).selectRotationWord({
            x: display.left + located.origin.x + located.size.width / 2,
            y: display.top + located.origin.y + located.size.height / 2,
          });
          const text = (await scope.getSelectedText().toPromise()).join('\n');
          const copied = new Promise<string>(resolve => { const unsubscribe = scope.onCopyToClipboard(value => { unsubscribe(); resolve(value); }); });
          scope.copyToClipboard();
          const copy = await copied;
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          const natural = scope.getHighlightRectsForPage(0);
          const painted = Array.from(image.parentElement!.querySelectorAll<HTMLDivElement>('div[style*="mix-blend-mode: multiply"][style*="isolation: isolate"] > div')).map(element => {
            const bounds = element.getBoundingClientRect();
            return { origin: { x: bounds.left - display.left, y: bounds.top - display.top }, size: { width: bounds.width, height: bounds.height } };
          });
          const expected = natural.map(rect => transformRect(pdfPage.size, rect, rotation, scale));
          if (painted.some((rect, index) => { const target = expected[index]; return !target || Math.abs(rect.origin.x - target.origin.x) > .6 || Math.abs(rect.origin.y - target.origin.y) > .6 || Math.abs(rect.size.width - target.size.width) > .6 || Math.abs(rect.size.height - target.size.height) > .6; })) {
            throw new Error(`Selection paint disagrees with rotated real-engine geometry: ${JSON.stringify({ documentId, rotation, text, copy, painted, expected })}`);
          }
          // Compare the actual composited paint with the original sibling multiply
          // layer. The baseline uses the same raster, token and rotated rects,
          // without introducing a transformed ancestor around the blend layer.
          const token = getComputedStyle(image.parentElement!).getPropertyValue('--review-pdf-selection-bg').trim();
          const left = Math.min(...expected.map(rect => rect.origin.x));
          const top = Math.min(...expected.map(rect => rect.origin.y));
          const right = Math.max(...expected.map(rect => rect.origin.x + rect.size.width));
          const bottom = Math.max(...expected.map(rect => rect.origin.y + rect.size.height));
          const clip = { x: Math.floor(display.left + left), y: Math.floor(display.top + top), width: Math.ceil(right - left), height: Math.ceil(bottom - top) };
          const capture = (window as unknown as { captureSelectionPixels(clip: { x: number; y: number; width: number; height: number }): Promise<string> }).captureSelectionPixels;
          const actualPixels = await capture(clip);
          const baseline = document.createElement('div');
          baseline.style.cssText = `position:fixed;left:${display.left}px;top:${display.top}px;width:${display.width}px;height:${display.height}px;z-index:100000;pointer-events:none;background:white`;
          // Browser render URLs may already be revoked after the original image
          // decodes; snapshot its decoded pixels instead of loading its URL again.
          const rasterPixels = document.createElement('canvas'); rasterPixels.width = image.naturalWidth; rasterPixels.height = image.naturalHeight;
          rasterPixels.getContext('2d')!.drawImage(image, 0, 0);
          const raster = document.createElement('img'); raster.src = rasterPixels.toDataURL();
          raster.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%'; baseline.append(raster);
          for (const rect of expected) {
            const layer = document.createElement('div');
            layer.style.cssText = `position:absolute;left:${rect.origin.x}px;top:${rect.origin.y}px;width:${rect.size.width}px;height:${rect.size.height}px;mix-blend-mode:multiply;isolation:isolate`;
            const paint = document.createElement('div'); paint.style.cssText = `width:100%;height:100%;background:${token}`;
            layer.append(paint); baseline.append(layer);
          }
          document.body.append(baseline);
          await raster.decode();
          let baselinePixels: string;
          try { baselinePixels = await capture(clip); } finally { baseline.remove(); }
          const decodePixels = async (value: string) => {
            const bitmap = await createImageBitmap(new Blob([decode(value)], { type: 'image/png' }));
            const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
            const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
            return { width: canvas.width, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
          };
          const [actualCapture, priorCapture] = await Promise.all([decodePixels(actualPixels), decodePixels(baselinePixels)]);
          const actual = actualCapture.pixels, prior = priorCapture.pixels;
          const isBackground = (index: number) => prior[index] === 207 && prior[index + 1] === 222 && prior[index + 2] === 234;
          let actualGlyphPixels = 0, baselineGlyphPixels = 0, backgroundPixels = 0, matchedBackgroundPixels = 0;
          for (let index = 0; index < prior.length; index += 4) {
            const glyph = (pixels: Uint8ClampedArray) => resourceHost === 'codex'
              ? pixels[index]! > 100 && pixels[index + 1]! < 100 && pixels[index + 2]! < 100
              : pixels[index]! < 100 && pixels[index + 1]! < 100 && pixels[index + 2]! < 100;
            if (glyph(prior)) baselineGlyphPixels++;
            if (glyph(actual)) actualGlyphPixels++;
            if (isBackground(index)) {
              backgroundPixels++;
              if (actual[index] === 207 && actual[index + 1] === 222 && actual[index + 2] === 234) matchedBackgroundPixels++;
            }
          }
          scope.clear();
          return { text, copy, painted, expected, token, actualGlyphPixels, baselineGlyphPixels, backgroundPixels, matchedBackgroundPixels };
        };
        const main = '.pdf-workspace:not(.pdf-workspace--reference) [data-page-index="0"] > img';
        const reference = '.pdf-workspace--reference [data-page-index="0"] > img';
        try {
          await initialized;
          const results = [];
          let previousMain: string | undefined, previousReference: string | undefined;
          for (const viewerRotation of [0, 1, 2, 3] as const) {
            registry.getStore().dispatch(setRotation(viewerRotation, MAIN_PDF_DOCUMENT_ID));
            registry.getStore().dispatch(setRotation(viewerRotation, REFERENCE_PDF_DOCUMENT_ID));
            const [mainRaster, referenceRaster] = await Promise.all([inspect(main, previousMain), inspect(reference, previousReference)]);
            const mainSelection = await inspectSelection(main, MAIN_PDF_DOCUMENT_ID);
            const referenceSelection = await inspectSelection(reference, REFERENCE_PDF_DOCUMENT_ID);
            results.push({ viewerRotation, main: mainRaster, reference: referenceRaster, selections: [mainSelection, referenceSelection] });
            previousMain = mainRaster.source; previousReference = referenceRaster.source;
          }
          return results;
        } finally { mounted.unmount(); await engine.destroy().toPromise(); for (const url of Object.values(resources)) URL.revokeObjectURL(url); }
      }, { pdf: Buffer.from(await fixture.save()).toString('base64'), workerSource, wasm: wasm.toString('base64'), css, resourceHost });
      for (const state of result) {
        const rotation = (intrinsicRotation + state.viewerRotation) % 4;
        for (const selection of state.selections) {
          expect(selection.token).toBe('#cfdeea');
          expect(selection.baselineGlyphPixels).toBeGreaterThan(20);
          expect(selection.actualGlyphPixels / selection.baselineGlyphPixels).toBeGreaterThan(.95);
          expect(selection.backgroundPixels).toBeGreaterThan(20);
          expect(selection.matchedBackgroundPixels).toBeGreaterThan(20);
          expect(selection.text).toBe('ROTATE'); expect(selection.copy).toBe(selection.text);
          expect(selection.painted.length).toBeGreaterThan(0);
          expect(selection.painted).toHaveLength(selection.expected.length);
          selection.painted.forEach((rect, index) => {
            const expected = selection.expected[index]!;
            expect(rect.origin.x).toBeCloseTo(expected.origin.x, 0);
            expect(rect.origin.y).toBeCloseTo(expected.origin.y, 0);
            expect(rect.size.width).toBeCloseTo(expected.size.width, 0);
            expect(rect.size.height).toBeCloseTo(expected.size.height, 0);
          });
        }
        const rotated = (x: number, y: number) => rotation === 0 ? { x, y } : rotation === 1 ? { x: 1 - y, y: x } : rotation === 2 ? { x: 1 - x, y: 1 - y } : { x: y, y: 1 - x };
        for (const raster of [state.main, state.reference]) {
          expect(raster.source.startsWith(resourceHost === 'codex' ? 'data:image/' : 'blob:')).toBe(true);
          expect(raster.width / raster.height).toBeCloseTo(rotation % 2 ? 600 / 400 : 400 / 600, 2);
          expect(raster.displayWidth / raster.displayHeight).toBeCloseTo(raster.width / raster.height, 2);
          const green = rotated(60 / 400, 560 / 600), blue = rotated(335 / 400, 105 / 600);
          expect(raster.green.x).toBeCloseTo(green.x, 2); expect(raster.green.y).toBeCloseTo(green.y, 2);
          expect(raster.blue.x).toBeCloseTo(blue.x, 2); expect(raster.blue.y).toBeCloseTo(blue.y, 2);
          expect(raster.overlay!.x).toBeCloseTo(raster.green.x, 2); expect(raster.overlay!.y).toBeCloseTo(raster.green.y, 2);
        }
      }
    });
  }
}
