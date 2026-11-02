import { createRoot } from 'react-dom/client';
import { RuntimeProductionReviewApp } from './production-entry.js';
import { createElectronHostRuntime } from './host/electron-runtime.js';
import type { ElectronShellBridge } from '../../../packages/core/src/electron-shell-protocol.js';
import './app/review-layout.css';
declare global {
    interface Window {
        placekeeper: ElectronShellBridge;
    }
}
async function start() {
    const bridge = window.placekeeper;
    const identity = await bridge.identity();
    const runtime = createElectronHostRuntime(bridge, identity);
    const root = document.getElementById('root');
    if (!root)
        throw new Error('Missing review root');
    root.dataset.productionRoot = 'true';
    createRoot(root).render(<RuntimeProductionReviewApp runtime={runtime} loadingDocumentTitle="Opening PDF" onDocumentReady={generation => {
            void bridge.documentReady(identity, generation).then(() => requestAnimationFrame(() => requestAnimationFrame(() => { void bridge.visible(identity, generation); })));
        }}/>);
    window.addEventListener('pagehide', () => runtime.dispose(), { once: true });
}
void start();
