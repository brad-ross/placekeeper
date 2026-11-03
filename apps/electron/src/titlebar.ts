import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

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
