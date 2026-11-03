import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeProductionReviewApp } from './production-entry.js';
import { FocusedLaunchNavigation } from './host/electron-focused-navigation.js';
import { createElectronHostRuntime } from './host/electron-runtime.js';
import type { ElectronShellBridge, ElectronShellIdentity } from '../../../packages/core/src/electron-shell-protocol.js';
import type { ReviewCommandInvocation, ReviewCommandSurfaceSnapshot } from './review/review-command-surface.js';
import './app/review-layout.css';
declare global { interface Window { placekeeper: ElectronShellBridge } }
const windowControlsOverlay = (navigator as Navigator & {
    windowControlsOverlay?: EventTarget & { readonly visible: boolean };
}).windowControlsOverlay;
function ElectronReview({ bridge, identity }: { bridge: ElectronShellBridge; identity: ElectronShellIdentity & { presentation?: { pageIndex: number; zoom: number } } }) {
    const [overlayVisible, setOverlayVisible] = useState(() => windowControlsOverlay?.visible === true);
    useLayoutEffect(() => {
        const update = () => setOverlayVisible(windowControlsOverlay?.visible === true);
        windowControlsOverlay?.addEventListener('geometrychange', update);
        update();
        return () => windowControlsOverlay?.removeEventListener('geometrychange', update);
    }, []);
    const [runtime] = useState(() => createElectronHostRuntime(bridge, identity));
    const [focusedNavigation] = useState(() => new FocusedLaunchNavigation({
        navigate: (location, generation) => runtime.navigateFocused(location, generation),
        painted: () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        visible: (generation, token) => bridge.visible(identity, generation, token),
        failed: token => bridge.focusFailed(identity, token),
    }));
    const [command, setCommand] = useState<ReviewCommandInvocation>();
    const revision = useRef(0);
    const currentSurface = useRef<ReviewCommandSurfaceSnapshot | undefined>(undefined);
    const settle = useRef<(() => Promise<void>) | undefined>(undefined);
    const [closing, setClosing] = useState(false);
    const publish = useCallback((snapshot: ReviewCommandSurfaceSnapshot) => {
        currentSurface.current = snapshot;
        const active = document.activeElement;
        const editable = active instanceof HTMLElement && (active.isContentEditable || active.matches('textarea,input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"])'));
        void bridge.commandSurface(identity, ++revision.current, editable ? { ...snapshot, focusContext: 'editable' } : snapshot);
    }, [bridge, identity]);
    useEffect(() => {
        const focusChanged = () => { if (currentSurface.current) publish(currentSurface.current); };
        document.addEventListener('focusin', focusChanged); document.addEventListener('focusout', focusChanged);
        return () => { document.removeEventListener('focusin', focusChanged); document.removeEventListener('focusout', focusChanged); };
    }, [publish]);
    useLayoutEffect(() => { const unsubscribe = bridge.subscribeShell(message => {
        if (message.type === 'command' && message.revision === revision.current) setCommand({ id: message.id, token: message.token });
        if (message.type === 'confirm-visible') void focusedNavigation.apply(message).catch(() => undefined);
        if (message.type === 'settle-close') {
            setClosing(true);
            requestAnimationFrame(() => { void (async () => {
                try { if (!settle.current) throw new Error('The review is still opening. Try closing it again after it loads.'); await settle.current(); await bridge.closeSettled(identity, message.token); }
                catch (error) { setClosing(false); await bridge.closeSettled(identity, message.token, error instanceof Error ? error.message : 'Input could not be protected').catch(() => undefined); }
            })(); });
        }
    }); void bridge.readyToSettle(identity); return unsubscribe; }, [bridge, identity]);
    useLayoutEffect(() => {
        const beforeUnload = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = '';
            void bridge.requestClose(identity);
        };
        window.addEventListener('beforeunload', beforeUnload);
        return () => window.removeEventListener('beforeunload', beforeUnload);
    }, [bridge, identity]);
    useEffect(() => { const dispose = () => { focusedNavigation.dispose(); runtime.dispose(); }; window.addEventListener('pagehide', dispose, { once: true }); return () => window.removeEventListener('pagehide', dispose); }, [runtime]);
    return <div className="electron-review-shell" data-window-controls-overlay={overlayVisible} inert={closing}>
        <RuntimeProductionReviewApp runtime={runtime} loadingDocumentTitle="Opening PDF"
            {...(identity.presentation ? { initialPresentation: identity.presentation } : {})}
            onPresentationChange={state => { void bridge.presentation(identity, state); }}
            registerCloseSettlement={handler => { settle.current = handler; }}
            onCommandSurfaceChange={publish} {...(command ? { commandInvocation: command } : {})}
            transitionAttemptId={identity.attemptId} transitionVisible
            onDocumentReady={generation => { void bridge.documentReady(identity, generation).then(() => requestAnimationFrame(() => requestAnimationFrame(() => { void bridge.visible(identity, generation); }))); }} />
    </div>;
}
async function start() {
    const bridge = window.placekeeper;
    const identity = await bridge.identity();
    // The shared client already uses asynchronous Clipboard.writeText; expose only
    // that operation where Chromium denies custom-scheme clipboard access.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: Object.freeze({ writeText: (text: string) => bridge.writeClipboard(identity, text) }) });
    const root = document.getElementById('root');
    if (!root) throw new Error('Missing review root');
    root.dataset.productionRoot = 'true';
    createRoot(root).render(<ElectronReview bridge={bridge} identity={identity} />);
}
void start();
