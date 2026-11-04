import { it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createDesktopIsolatedRoot } from '../../../test/support/desktop-isolated-root.js';
import { BrowserSourceStore } from '../src/browser/browser-source-store.js';
import { ensurePrivateDirectory, verifyPrivatePath, writePrivateFile } from '../src/platform/private-storage.js';

it.runIf(process.platform === 'win32')('creates the daemon browser store using its actual private DACL and adopts a sealed source durably', async () => {
    const root = await createDesktopIsolatedRoot();
    try {
        const store = await BrowserSourceStore.create(join(root, 'browser-sources'));
        await verifyPrivatePath(store.root, 'directory');
        // Windows stat mode does not encode the verified DACL above.
        expect((await lstat(store.root)).mode & 0o077).not.toBe(0);
        const sourceHandle = randomBytes(24).toString('base64url');
        const source = join(store.root, `${sourceHandle}.pdf`);
        const bytes = Buffer.from('%PDF-1.7\nprivate sealed source\n%%EOF');
        await writePrivateFile(source, bytes);
        const destinationRoot = join(root, 'review'); await ensurePrivateDirectory(destinationRoot);
        const request = { protocolVersion: 2 as const, sourceIdentity: 'a'.repeat(64), sourceHandle, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        const adopted = await store.adopt(request, destinationRoot);
        expect(await readFile(adopted.path)).toEqual(bytes);
        await verifyPrivatePath(adopted.path, 'file');
        await expect(access(source)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);
it.runIf(process.platform === 'win32')('a private adoption collision preserves both the sealed original and unrelated existing destination', async () => {
    const root = await createDesktopIsolatedRoot();
    try {
        const store = await BrowserSourceStore.create(join(root, 'browser-sources'));
        const sourceHandle = randomBytes(24).toString('base64url');
        const source = join(store.root, `${sourceHandle}.pdf`);
        const bytes = Buffer.from('%PDF-1.7\nsealed source\n%%EOF'); await writePrivateFile(source, bytes);
        const destinationRoot = join(root, 'review'); await ensurePrivateDirectory(destinationRoot);
        const destination = join(destinationRoot, 'source.pdf'); await writePrivateFile(destination, 'keep unrelated destination');
        await expect(store.adopt({ protocolVersion: 1, sourceHandle, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, destinationRoot)).rejects.toMatchObject({ code: 'EEXIST' });
        expect(await readFile(source)).toEqual(bytes);
        expect(await readFile(destination, 'utf8')).toBe('keep unrelated destination');
        await promisify(execFile)(join(process.env.SystemRoot!, 'System32', 'icacls.exe'), [source, '/grant', '*S-1-1-0:(R)'], { windowsHide: true });
        await expect(store.adopt({ protocolVersion: 1, sourceHandle, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, join(root, 'other-review'))).rejects.toThrow();
        expect(await readFile(source)).toEqual(bytes);
    } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);
