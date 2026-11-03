import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { REVIEW_COMMAND_IDS, type ReviewCommandSurfaceSnapshot, type ReviewSemanticCommand } from '../../web/src/review/review-command-surface.js';
import { setInterfaceZoom } from './titlebar.js';
export interface WindowCommands { readonly revision: number; readonly snapshot: ReviewCommandSurfaceSnapshot }
export function commandEnabled(state: WindowCommands | undefined, id: ReviewSemanticCommand): boolean {
    return state?.snapshot.commands.find(command => command.id === id)?.enabled === true;
}
let commandToken = 0;
export function installMenus(open: () => void, focused: () => { window: BrowserWindow; commands?: WindowCommands } | undefined): void {
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
        { label: 'Review', submenu: REVIEW_COMMAND_IDS.filter(id => id !== 'undo' && id !== 'redo').map(id => command(id, accelerators[id])) },
        { label: 'View', submenu: [{ label: 'Increase Interface Size', accelerator: 'CommandOrControl+Alt+=', click: () => { const w = focused()?.window; if (w) setInterfaceZoom(w, Math.min(3, w.webContents.getZoomLevel() + 0.5)); } }, { label: 'Decrease Interface Size', accelerator: 'CommandOrControl+Alt+-', click: () => { const w = focused()?.window; if (w) setInterfaceZoom(w, Math.max(-2, w.webContents.getZoomLevel() - 0.5)); } }, { label: 'Actual Interface Size', click: () => { const w = focused()?.window; if (w) setInterfaceZoom(w, 0); } }, { role: 'togglefullscreen' }] },
        { role: 'windowMenu' },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
