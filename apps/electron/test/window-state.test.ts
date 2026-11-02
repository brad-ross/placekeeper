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
