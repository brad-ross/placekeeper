import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeProductionReviewApp } from '../production-entry.js';
import { createStaticHostRuntime } from '../host/static-runtime.js';
import type { HostRuntime, HostRuntimeBootstrap } from '../host/runtime.js';
import type { ViewerAssetUrls } from '../pdf/embedpdf-viewer.js';
import { WorkspaceInitialReferenceDock, WorkspaceModeAvailability, WorkspacePresentation } from '../review/WorkspaceModeStrip.js';
import { DocumentActionsEnabled } from '../review/DocumentActionsMenu.js';
import { MainDocumentPreviewLimit } from '../pdf/MainDocumentPreviewBoundary.js';
import { createDemoItems } from './create-demo-items.js';
import { createDemoDocument } from './create-demo-document.js';

const DEMO_PAGE_RANGE = { firstPage: 14, lastPage: 16 };

export type DemoMode = 'read' | 'reference' | 'annotate';

function DemoApp({ runtime, initial, mode }: { runtime: HostRuntime; initial: HostRuntimeBootstrap; mode: DemoMode }) {
  const [ready, setReady] = useState(false);
  const [selectedMode, setSelectedMode] = useState(mode);
  useEffect(() => {
    const frame = window.frameElement;
    const update = () => {
      const next = frame?.getAttribute('data-demo-mode');
      if (next === 'read' || next === 'reference' || next === 'annotate') {
        document.body.dataset.landingDemo = next;
        setSelectedMode(next);
      }
    };
    update();
    const observer = new MutationObserver(update);
    if (frame) observer.observe(frame, { attributes: true, attributeFilter: ['data-demo-mode'] });
    return () => observer.disconnect();
  }, []);
  return <MainDocumentPreviewLimit value={DEMO_PAGE_RANGE}><DocumentActionsEnabled value={false}><WorkspaceInitialReferenceDock value="right"><WorkspaceModeAvailability value={selectedMode === 'read' ? ['outline'] : selectedMode === 'reference' ? ['references'] : ['annotations']}>
    <WorkspacePresentation value={ready ? { mode: selectedMode === 'read' ? 'outline' : selectedMode === 'reference' ? 'references' : 'annotations', open: selectedMode !== 'read', referenceDock: 'bottom', sampleReference: { page: 31, label: 'Appendix A', pdfY: 175.702 }, bottomHeight: 260, initialLocation: { pageIndex: 13, top: 330 } } : null}>
    <RuntimeProductionReviewApp runtime={runtime} initial={initial}
      onDocumentReady={() => { document.body.dataset.demoReady = 'true'; setReady(true); }}
    />
    </WorkspacePresentation>
  </WorkspaceModeAvailability></WorkspaceInitialReferenceDock></DocumentActionsEnabled></MainDocumentPreviewLimit>;
}

export async function mountLandingDemo(mode: DemoMode, viewerAssets: Pick<ViewerAssetUrls, 'pdfiumWasm' | 'workerUrl'>): Promise<void> {
  // The embedded demo is a fixed, bundled document. It never accepts a file or URL from its parent.
  if (window.parent !== window && window.parent.location.origin !== location.origin) throw new Error('Demo host is unavailable.');
  const root = document.querySelector<HTMLElement>('#root');
  if (!root) return;
  document.body.dataset.landingDemo = mode;
  const runtime = await createStaticHostRuntime({ source: { name: 'Estimating Counterfactual Matrix Means.pdf', bytes: await createDemoDocument() }, viewerAssets }, {
    lifecycle: { addEventListener() {}, removeEventListener() {} },
  });
  for (const item of await createDemoItems()) {
    const current = await runtime.bootstrap();
    await runtime.command({ type: 'add', expectedRevision: current.state.revision, item });
  }
  const initial = await runtime.bootstrap();
  root.dataset.productionRoot = 'true';
  const app = createRoot(root);
  app.render(<DemoApp runtime={runtime} initial={initial} mode={mode} />);
  window.addEventListener('pagehide', () => { app.unmount(); runtime.dispose(); }, { once: true });
}
