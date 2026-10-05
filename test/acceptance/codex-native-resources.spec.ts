import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

test('native verified resources decode Main and Reference pixels without network or Blob images', async ({ page }) => {
  const [workerSource, wasm, sourcePdf, css] = await Promise.all([
    readFile('dist/web/pdfium-codex-worker.js', 'utf8'),
    readFile('dist/web/pdfium.wasm'),
    readFile('test/fixtures/pdfs/reference-navigation.pdf'),
    readFile('dist/web/app.css', 'utf8'),
  ]);
  const fixture = await PDFDocument.load(sourcePdf);
  // Exercise a saved Multiply appearance alongside the fixture's explicit Normal highlight.
  const highlightAppearance = fixture.context.register(fixture.context.stream('/GS0 gs 1 1 0 rg 0 0 80 12 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 80, 12], Resources: { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply' } } } }));
  fixture.getPages()[0]!.node.addAnnot(fixture.context.register(fixture.context.obj({ Type: 'Annot', Subtype: 'Highlight', Rect: [320, 500, 400, 512], QuadPoints: [320, 512, 400, 512, 320, 500, 400, 500], BM: 'Multiply', AP: { N: highlightAppearance }, F: 4 })));
  const appearance = fixture.context.register(fixture.context.stream('0 .8 0 rg 0 0 40 40 re f .6 0 1 rg 40 0 40 40 re f 0 0 0 rg 0 0 10 10 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 80, 40], Matrix: [0, 1, -1, 0, 40, 0] }));
  fixture.getPages()[0]!.node.addAnnot(fixture.context.register(fixture.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [320, 540, 400, 580], AP: { N: appearance }, Contents: 'Native original AP preservation', F: 4 })));
  const pdf = Buffer.from(await fixture.save());
  await page.route('**/native-resource-gate', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' blob: \'wasm-unsafe-eval\'; worker-src blob:; connect-src \'none\'; img-src \'self\' data:; style-src \'unsafe-inline\'">' }));
  await page.goto('/native-resource-gate');
  const result = await page.evaluate(async ({ workerSource, wasm, pdf, css }) => {
    const { createLocalPdfiumViewer, buildViewerDocumentOptions } = await import(/* @vite-ignore */ ('/apps/web/src/pdf/embedpdf-viewer.ts' as string)) as typeof import('../../apps/web/src/pdf/embedpdf-viewer.js');
    const { buildReferenceDocumentOptions } = await import(/* @vite-ignore */ ('/apps/web/src/pdf/reference-document.ts' as string)) as typeof import('../../apps/web/src/pdf/reference-document.js');
    const { fetchSourceAnnotationStyles } = await import(/* @vite-ignore */ ('/apps/web/src/pdf/source-annotation-style.ts' as string)) as typeof import('../../apps/web/src/pdf/source-annotation-style.js');
    const { PdfWorkspace } = await import(/* @vite-ignore */ ('/apps/web/src/pdf/PdfWorkspace.tsx' as string)) as typeof import('../../apps/web/src/pdf/PdfWorkspace.js');
    const { default: { createElement } } = await import(/* @vite-ignore */ ('/@id/react' as string)) as { default: typeof import('react') };
    const { default: { createRoot } } = await import(/* @vite-ignore */ ('/@id/react-dom/client' as string)) as { default: typeof import('react-dom/client') };
    const { DocumentManagerPlugin } = await import(/* @vite-ignore */ ('/@id/@embedpdf/plugin-document-manager' as string)) as typeof import('@embedpdf/plugin-document-manager');
    const { createEngineDestinationSnippetRenderer, createDestinationSnippetSession } = await import(/* @vite-ignore */ ('/apps/web/src/pdf/destination-snippet.ts' as string)) as typeof import('../../apps/web/src/pdf/destination-snippet.js');
    const decode = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));
    const documentBytes = decode(pdf);
    const pdfiumWasmBytes = decode(wasm);
    const resources = {
      document: URL.createObjectURL(new Blob([documentBytes], { type: 'application/pdf' })),
      pdfiumWasm: URL.createObjectURL(new Blob([pdfiumWasmBytes], { type: 'application/wasm' })),
      worker: URL.createObjectURL(new Blob([workerSource], { type: 'application/javascript' })),
    };
    const violations: Array<{ effectiveDirective: string; blockedURI: string; sourceFile: string; lineNumber: number; images: string[] }> = [];
    document.addEventListener('securitypolicyviolation', event => violations.push({ effectiveDirective: event.effectiveDirective, blockedURI: event.blockedURI, sourceFile: event.sourceFile, lineNumber: event.lineNumber, images: [...document.querySelectorAll<HTMLImageElement>('img[src^="blob:"]')].map(image => image.parentElement?.outerHTML.slice(0, 1500) ?? image.outerHTML) }));
    const policy = { host: 'codex', resources } as const;
    const assets = { documentUrl: resources.document, pdfiumWasm: resources.pdfiumWasm, workerUrl: resources.worker, documentBytes, pdfiumWasmBytes };
    const { engine, plugins } = createLocalPdfiumViewer(assets, policy);
    let unmount: (() => void) | undefined;
    try {
      const options = buildViewerDocumentOptions(assets, policy);
      if (!('buffer' in options)) throw new Error('Native PDF must use buffer loading');
      const loaded = await engine.openDocumentBuffer({ id: 'native-resource-gate', content: options.buffer }).toPromise();
      const rendered = await engine.renderPage(loaded, loaded.pages[0]!).toPromise();
      const styles = await fetchSourceAnnotationStyles(buildViewerDocumentOptions(assets, policy));
      const snippetImage = document.createElement('img');
      snippetImage.id = 'native-snippet'; document.body.append(snippetImage);
      const snippet = createDestinationSnippetSession({
        render: createEngineDestinationSnippetRenderer({ engine, document: loaded, documentGeneration: 1, resourceHost: 'codex' }),
        onChange: state => { if (state.status === 'ready') snippetImage.src = state.url; },
      });
      snippet.load({ documentGeneration: 1, targetIdentity: 'native-snippet', pageIndex: 0, pageNumeral: '1', spot: null, extent: null, clickedText: null, heading: null, kindLabel: null, name: 'Page 1', nameSource: 'page' });
      await new Promise<void>((resolve, reject) => { snippetImage.onload = () => resolve(); snippetImage.onerror = reject; });
      await engine.closeDocument(loaded).toPromise();
      const reference = buildReferenceDocumentOptions(assets, policy);
      if (!('buffer' in reference)) throw new Error('Native Reference must use buffer loading');
      const referenceLoaded = await engine.openDocumentBuffer({ id: reference.documentId!, content: reference.buffer }).toPromise();
      await engine.closeDocument(referenceLoaded).toPromise();
      const style = document.createElement('style');
      style.textContent = css;
      document.head.append(style);
      const root = document.createElement('div');
      root.id = 'root'; root.dataset.productionRoot = 'true';
      document.body.append(root);
      const referenceHost = document.createElement('div');
      referenceHost.style.cssText = 'position:fixed;right:0;top:0;width:400px;height:600px';
      document.body.append(referenceHost);
      const mounted = createRoot(root);
      unmount = () => mounted.unmount();
      mounted.render(createElement(PdfWorkspace, {
        engine, plugins, resourceHost: 'codex', referenceViewportHost: referenceHost, referenceTabIdentity: 'native-raster-gate',
        onInitialized: async registry => {
          const manager = registry.getPlugin<InstanceType<typeof DocumentManagerPlugin>>(DocumentManagerPlugin.id)?.provides();
          if (!manager) throw new Error('Document manager unavailable');
          const opened = await manager.openDocumentBuffer(reference).toPromise();
          await opened.task.toPromise();
        },
      }));
      const inspectRaster = (selector: string) => new Promise<{ width: number; height: number; colors: number; source: string; greenPixels: number; purplePixels: number; transforms: string[]; samples: { top: number[]; bottom: number[] } }>((resolve, reject) => {
        const observer = new MutationObserver(inspect);
        let decoding = false;
        function inspect() {
          const image = document.querySelector<HTMLImageElement>(selector);
          if (!image || decoding) return;
          decoding = true;
          void image.decode().then(() => {
            observer.disconnect();
            const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
            const context = canvas.getContext('2d')!;
            context.drawImage(image, 0, 0, 128, 128);
            const pixels = context.getImageData(0, 0, 128, 128).data;
            const colors = new Set<number>();
            let greenPixels = 0; let purplePixels = 0;
            for (let index = 0; index < pixels.length; index += 4) {
              colors.add((pixels[index]! << 16) | (pixels[index + 1]! << 8) | pixels[index + 2]!);
              if (pixels[index]! < 2 && Math.abs(pixels[index + 1]! - 204) < 2 && pixels[index + 2]! < 2) greenPixels++;
              if (Math.abs(pixels[index]! - 153) < 2 && pixels[index + 1]! < 2 && pixels[index + 2]! > 253) purplePixels++;
            }
            const transforms: string[] = [];
            for (let ancestor = image.parentElement; ancestor; ancestor = ancestor.parentElement) {
              const transform = getComputedStyle(ancestor).transform;
              if (transform !== 'none') transforms.push(transform);
            }
            resolve({ width: image.naturalWidth, height: image.naturalHeight, colors: colors.size, source: image.src.slice(0, 30), greenPixels, purplePixels, transforms, samples: { top: [...pixels.slice((32 * 128 + 64) * 4, (32 * 128 + 64) * 4 + 4)], bottom: [...pixels.slice((96 * 128 + 64) * 4, (96 * 128 + 64) * 4 + 4)] } });
          }, error => { observer.disconnect(); reject(error); });
        }
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] }); inspect();
      });
      const rasters = await Promise.all([
        inspectRaster('.pdf-workspace:not(.pdf-workspace--reference) [data-page-index="0"] > img'),
        inspectRaster('.pdf-workspace--reference [data-page-index="0"] > img'),
      ]);
      const stamp = await inspectRaster('.pdf-workspace:not(.pdf-workspace--reference) [data-native-source-appearance-type="13"] > img');
      const snippetRaster = await inspectRaster('#native-snippet');
      const highlights = [...document.querySelectorAll('.pdf-workspace:not(.pdf-workspace--reference) [data-native-source-appearance-type="9"]')];
      const highlightStyles = highlights.map(highlight => {
        const container = highlight.closest('[data-no-interaction]')?.firstElementChild;
        if (!container) throw new Error('Native highlight appearance container unavailable');
        const computed = getComputedStyle(container);
        return { mixBlendMode: computed.mixBlendMode, zIndex: computed.zIndex };
      });
      snippet.dispose();
      return { pages: loaded.pageCount, referencePages: referenceLoaded.pageCount, styledPages: styles.pageAnnotationCounts.length, renderedBytes: rendered.size, retainedDocumentBytes: documentBytes.byteLength, retainedWasmBytes: pdfiumWasmBytes.byteLength, rasters, stamp, snippetRaster, highlightStyles, violations };
    } finally {
      unmount?.();
      await engine.destroy();
      for (const url of Object.values(resources)) URL.revokeObjectURL(url);
    }
  }, { workerSource, wasm: wasm.toString('base64'), pdf: pdf.toString('base64'), css });
  const evidence = test.info().outputPath('native-raster-evidence.json');
  await writeFile(evidence, JSON.stringify(result, null, 2));
  await test.info().attach('native-raster-evidence', { path: evidence, contentType: 'application/json' });
  expect(result.pages).toBe(4);
  expect(result.referencePages).toBe(4);
  expect(result.styledPages).toBe(4);
  expect(result.renderedBytes).toBeGreaterThan(0);
  expect(result.retainedDocumentBytes).toBe(pdf.length);
  expect(result.retainedWasmBytes).toBe(wasm.length);
  for (const raster of result.rasters) {
    expect(raster.source).toMatch(/^data:image\//u);
    expect(raster.width).toBeGreaterThan(0);
    expect(raster.height).toBeGreaterThan(0);
    expect(raster.colors).toBeGreaterThan(1);
  }
  expect(result.stamp.source).toMatch(/^data:image\//u);
  expect(result.stamp.greenPixels).toBeGreaterThan(0);
  expect(result.stamp.purplePixels).toBeGreaterThan(0);
  // The AP matrix rotates green-left/purple-right into purple-top/green-bottom.
  expect(result.stamp.samples.top).toEqual([153, 0, 255, 255]);
  expect(result.stamp.samples.bottom).toEqual([0, 204, 0, 255]);
  expect(result.snippetRaster.source).toMatch(/^data:image\//u);
  expect(result.snippetRaster.width).toBeGreaterThan(0);
  expect(result.highlightStyles).toContainEqual({ mixBlendMode: 'normal', zIndex: '0' });
  expect(result.highlightStyles).toContainEqual({ mixBlendMode: 'multiply', zIndex: '0' });
  expect(result.violations).toEqual([]);
});
