import { it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWindowState, writeWindowState } from '../src/window-state.js';
it('absent, empty, truncated and invalid restoration never prevent opening a PDF', async () => {
    const root = await mkdtemp(join(tmpdir(), 'electron-state-'));
    const path = join(root, 'windows.json');
    try {
        expect(await readWindowState(path)).toEqual([]);
        for (const value of ['', '[{"sourcePath":', 'null', '{"sessionId":"secret"}']) {
            await writeFile(path, value); expect(await readWindowState(path)).toEqual([]);
        }
    } finally { await rm(root, { recursive: true, force: true }); }
});
it('state publication atomically replaces the current sibling and cleans failed temporary files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'electron-state-'));
    const path = join(root, 'windows.json');
    try {
        const state = [{ sourcePath: '/paper.pdf', bounds: { width: 1200, height: 900 }, maximized: false }];
        await writeFile(path, 'prior');
        await writeWindowState(path, state);
        expect(await readWindowState(path)).toEqual(state);
        expect(await readdir(root)).toEqual(['windows.json']);
        const directory = join(root, 'cannot-replace-directory'); await mkdir(directory);
        await writeFile(join(directory, 'keep'), 'retained');
        await expect(writeWindowState(directory, state)).rejects.toThrow();
        expect(await readFile(join(directory, 'keep'), 'utf8')).toBe('retained');
        expect((await readdir(root)).some(name => name.endsWith('.tmp'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
});
it('imports validated AppKit preferences once, preserves the original, and never overwrites Electron choices', async () => {
    const { importLegacyMacPreferences, readLegacyInterfaceScale } = await import('../src/window-state.js');
    const root = await mkdtemp(join(tmpdir(), 'legacy-preferences-'));
    const value = JSON.parse(await readFile(new URL('../../../test/fixtures/legacy-release-0.2.4/preferences.json', import.meta.url), 'utf8'));
    try {
        await importLegacyMacPreferences({ profileRoot: root, preferences: value });
        expect((await readWindowState(join(root, 'windows.json')))[0]?.presentation).toEqual({ pageIndex: 2, zoom: 16 });
        expect(await readLegacyInterfaceScale(root)).toBe(1.25);
        const newer = [{ sourcePath: '/new.pdf', bounds: { width: 900, height: 700 }, maximized: true }];
        await writeWindowState(join(root, 'windows.json'), newer);
        await importLegacyMacPreferences({ profileRoot: root, preferences: value });
        expect(await readWindowState(join(root, 'windows.json'))).toEqual(newer);
        expect(value['Placekeeper.AppZoom.v1']).toBe(1.25);
    } finally { await rm(root, { recursive: true, force: true }); }
});
it('preserves existing or corrupt destination preferences and drops unrecognized restoration records', async () => {
    const { importLegacyMacPreferences } = await import('../src/window-state.js');
    const root = await mkdtemp(join(tmpdir(), 'legacy-existing-'));
    try {
        await writeFile(join(root, 'windows.json'), 'corrupt but preserved');
        await writeFile(join(root, 'interface-scale.json'), '1.5');
        await importLegacyMacPreferences({ profileRoot: root, preferences: { 'Placekeeper.AppZoom.v1': 1.25,
            'Placekeeper.RestorableDocumentWindows.v1': [{ sourcePath: '/paper.pdf', frame: '{{0, 0}, {900, 700}}', token: 'credential' }] } });
        expect(await readFile(join(root, 'windows.json'), 'utf8')).toBe('corrupt but preserved');
        expect(await readFile(join(root, 'interface-scale.json'), 'utf8')).toBe('1.5');
        expect((await readFile(join(root, 'appkit-preferences-imported.json'), 'utf8'))).not.toContain('credential');
    } finally { await rm(root, { recursive: true, force: true }); }
});
it.skipIf(process.platform !== 'darwin')('reads the released plist keys without changing the source preference file', async () => {
    const { importLegacyMacPreferences } = await import('../src/window-state.js');
    const root = await mkdtemp(join(tmpdir(), 'legacy-plist-'));
    try {
        const original = await readFile(new URL('../../../test/fixtures/legacy-release-0.2.4/preferences.plist', import.meta.url));
        const preferences = join(root, 'Library/Preferences'); await mkdir(preferences, { recursive: true });
        const path = join(preferences, 'local.placekeeper.plist'); await writeFile(path, original);
        const profileRoot = join(root, 'electron');
        await importLegacyMacPreferences({ profileRoot, homeDirectory: root });
        expect((await readWindowState(join(profileRoot, 'windows.json')))[0]?.sourcePath).toBe('/private/example/paper.pdf');
        expect(await readFile(path)).toEqual(original);
    } finally { await rm(root, { recursive: true, force: true }); }
});
