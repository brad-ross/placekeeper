import { it, expect, vi } from 'vitest';
const menu = vi.hoisted(() => ({ template: [] as any[] }));
vi.mock('electron', () => ({ Menu: { buildFromTemplate: (template: any[]) => { menu.template = template; return template; }, setApplicationMenu() {} } }));
import { installMenus } from '../src/menus.js';
it('native semantic commands keep increasing tokens across command snapshot and focus rebuilds', () => {
    const send = vi.fn();
    const focused = () => ({ window: { webContents: { send } } as any, commands: { revision: 4, snapshot: { focusContext: 'review' as const, commands: [{ id: 'find' as const, label: 'Find in PDF', enabled: true }] } } });
    installMenus(() => {}, focused);
    menu.template.find(item => item.label === 'Review').submenu.find((item: any) => item.label === 'Find in PDF').click();
    installMenus(() => {}, focused);
    menu.template.find(item => item.label === 'Review').submenu.find((item: any) => item.label === 'Find in PDF').click();
    expect(send.mock.calls[1]![1].token).toBeGreaterThan(send.mock.calls[0]![1].token);
});
it('focused editable undo routes to native text editing instead of review history', () => {
    installMenus(() => {}, () => ({ window: {} as any, commands: { revision: 1, snapshot: { focusContext: 'editable', commands: [] } } }));
    expect(menu.template.find(item => item.label === 'Edit').submenu[0]).toEqual({ role: 'undo' });
});
