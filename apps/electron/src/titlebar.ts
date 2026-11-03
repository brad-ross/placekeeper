import type { BrowserWindow, BrowserWindowConstructorOptions, Point } from 'electron';

const toolbarHeight = 52;
const trafficLightRadius = 7;

function trafficLightPosition(scale: number) {
    return { x: Math.round(16 * scale), y: Math.round(toolbarHeight * scale / 2 - trafficLightRadius) };
}

export function nativeTitlebarOptions(platform = process.platform): BrowserWindowConstructorOptions {
    return {
        titleBarStyle: 'hidden',
        // On macOS the traffic-light margins determine the native row height.
        // Its overlay cannot be resized with setTitleBarOverlay after creation.
        titleBarOverlay: platform === 'darwin' ? true : { height: toolbarHeight, color: '#f7f7f7', symbolColor: '#292929' },
        ...(platform === 'darwin' ? { trafficLightPosition: trafficLightPosition(1) } : { autoHideMenuBar: true }),
    };
}

export function setInterfaceZoom(window: BrowserWindow, level: number, platform = process.platform): void {
    window.webContents.setZoomLevel(level);
    const scale = window.webContents.getZoomFactor();
    if (platform === 'darwin') window.setWindowButtonPosition(trafficLightPosition(scale));
    else window.setTitleBarOverlay({ height: Math.round(toolbarHeight * scale) });
}

export function trackTitlebarHover(window: BrowserWindow, cursor: () => Point, height: () => number = () => toolbarHeight): () => void {
    const contents = window.webContents;
    let timer: ReturnType<typeof setInterval> | undefined;
    let hovered: boolean | undefined;
    const publish = (next: boolean) => {
        if (hovered === next || contents.isDestroyed()) return;
        hovered = next;
        contents.send('review:shell', { type: 'toolbar-hover', hovered: next });
    };
    const sample = () => {
        const point = cursor();
        const bounds = window.getContentBounds();
        publish(point.x >= bounds.x && point.x < bounds.x + bounds.width
            && point.y >= bounds.y && point.y < bounds.y + height() * contents.getZoomFactor());
    };
    const stop = () => { if (timer) clearInterval(timer); timer = undefined; publish(false); };
    const start = () => {
        if (!window.isFocused() || !window.isVisible() || window.isMinimized()) return;
        sample();
        // Native drag regions suppress DOM pointer events.
        timer ??= setInterval(sample, 50);
        timer.unref();
    };
    const loaded = () => { hovered = undefined; start(); };
    window.on('focus', start); window.on('show', start); window.on('restore', start);
    window.on('blur', stop); window.on('hide', stop); window.on('minimize', stop);
    contents.on('did-finish-load', loaded);
    start();
    return () => {
        stop();
        window.removeListener('focus', start); window.removeListener('show', start); window.removeListener('restore', start);
        window.removeListener('blur', stop); window.removeListener('hide', stop); window.removeListener('minimize', stop);
        contents.removeListener('did-finish-load', loaded);
    };
}
