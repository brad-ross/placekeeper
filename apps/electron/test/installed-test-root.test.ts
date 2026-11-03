import { it, expect, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopIsolatedRoot } from '../../../test/support/desktop-isolated-root.js';
import { verifyPrivatePath } from '../../service/src/platform/private-storage.js';
import * as privateStorage from '../../service/src/platform/private-storage.js';
import { readControlDiscovery, requestPrivateControl, startPrivateControlServer } from '../../service/src/platform/control-transport.js';

it('prepared installed fixture root admits absent discovery and authenticated control', async () => {
    const root = await createDesktopIsolatedRoot();
    try {
        await verifyPrivatePath(root, 'directory');
        const path = join(root, 'control.sock');
        await expect(readControlDiscovery(path)).rejects.toMatchObject({ code: 'ENOENT' });
        const server = await startPrivateControlServer(path, async () => ({ type: 'registered' }));
        try { expect(await requestPrivateControl(path, { type: 'register' })).toEqual({ type: 'registered' }); }
        finally { await server.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
});

it.runIf(process.platform === 'win32')('unsafe parent ACL still fails closed before missing discovery can start a daemon', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pk-unsafe-desktop-'));
    try {
        await promisify(execFile)(join(process.env.SystemRoot!, 'System32', 'icacls.exe'), [root, '/grant', '*S-1-1-0:(R)'], { windowsHide: true });
        await expect(readControlDiscovery(join(root, 'control.sock'))).rejects.toMatchObject({ reason: 'malformed' });
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('failed fixture privacy preparation removes only its newly created root', async () => {
    let created: string | undefined;
    const refusal = new Error('private root refused');
    const establish = vi.spyOn(privateStorage, 'establishPrivateDirectory').mockImplementation(async path => { created = path; throw refusal; });
    try {
        await expect(createDesktopIsolatedRoot()).rejects.toBe(refusal);
        expect(created).toBeDefined();
        await expect(access(created!)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { establish.mockRestore(); if (created) await rm(created, { recursive: true, force: true }); }
});
