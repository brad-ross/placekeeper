import { REVIEW_RUNTIME_PROTOCOL, REVIEW_RUNTIME_VERSION } from '../../../packages/core/src/review-runtime-protocol.js';
import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { REVIEW_COMMAND_IDS, type ReviewCommandSurfaceSnapshot, type ReviewSemanticCommand } from '../../web/src/review/review-command-surface.js';
import { setInterfaceZoom } from './titlebar.js';
export interface WindowCommands { readonly revision: number; readonly snapshot: ReviewCommandSurfaceSnapshot }
export function commandEnabled(state: WindowCommands | undefined, id: ReviewSemanticCommand): boolean {
    return state?.snapshot.focusContext !== 'dialog' && state?.snapshot.commands.find(command => command.id === id)?.enabled === true;
}
let commandToken = 0;
export function installMenus(open: () => void, focused: () => { window: BrowserWindow; commands?: WindowCommands; bridge?: { active: boolean; retired: boolean; windowId: string }; configureSource?: () => void } | undefined, checkUpdates: () => void): void {
    const command = (id: ReviewSemanticCommand, accelerator?: string): MenuItemConstructorOptions => {
        const current = focused();
        const editable = current?.commands?.snapshot.focusContext === 'editable';
        if ((id === 'undo' || id === 'redo') && editable) return { role: id };
        return { label: current?.commands?.snapshot.commands.find(item => item.id === id)?.label ?? id, enabled: commandEnabled(current?.commands, id), ...(accelerator ? { accelerator } : {}), click() {
            const active = focused();
            if (active && commandEnabled(active.commands, id)) active.window.webContents.send('review:shell', { type: 'command', id, token: ++commandToken, revision: active.commands!.revision });
        } };
    };
    const accelerators: Partial<Record<ReviewSemanticCommand, string>> = { undo: 'CommandOrControl+Z', redo: 'CommandOrControl+Shift+Z', find: 'CommandOrControl+F', 'navigate-back': 'CommandOrControl+[', 'navigate-forward': 'CommandOrControl+]', 'zoom-in': 'CommandOrControl+=', 'zoom-out': 'CommandOrControl+-', 'fit-width': 'CommandOrControl+Alt+0' };
    const template: MenuItemConstructorOptions[] = [
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
        { label: 'File', submenu: [{ label: 'Open PDF…', accelerator: 'CommandOrControl+O', click: open }, { type: 'separator' }, { role: 'close' }] },
        { label: 'Edit', submenu: [command('undo', accelerators.undo), command('redo', accelerators.redo), { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
        { label: 'Review', submenu: [...REVIEW_COMMAND_IDS.filter(id => id !== 'undo' && id !== 'redo').map(id => command(id, accelerators[id])), { type: 'separator' }, { label: 'Go to Source', accelerator: 'CommandOrControl+Shift+J', enabled: focused()?.bridge?.active === true, click: () => { const e = focused(); if (e?.bridge?.active && !e.bridge.retired) e.window.webContents.send('review:event', { protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION, kind: 'event', runtimeId: e.bridge.windowId, event: 'host-command', payload: { command: 'reverse-synctex' } }); } }, { label: 'Configure Source Navigation…', enabled: focused()?.bridge?.active === true, click: () => { const e = focused(); if (e?.bridge?.active && !e.bridge.retired) e.configureSource?.(); } }] },
        { label: 'View', submenu: [{ label: 'Increase Interface Size', accelerator: 'CommandOrControl+Alt+=', click: () => { const w = focused()?.window; if (w) setInterfaceZoom(w, Math.min(3, w.webContents.getZoomLevel() + 0.5)); } }, { label: 'Decrease Interface Size', accelerator: 'CommandOrControl+Alt+-', click: () => { const w = focused()?.window; if (w) setInterfaceZoom(w, Math.max(-2, w.webContents.getZoomLevel() - 0.5)); } }, { label: 'Actual Interface Size', click: () => { const w = focused()?.window; if (w) setInterfaceZoom(w, 0); } }, { role: 'togglefullscreen' }] },
        { role: 'windowMenu' },
        { label: 'Help', submenu: [{ label: 'Check for Updates…', click: checkUpdates }] },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
