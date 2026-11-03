import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePrivateDirectory, establishPrivateDirectory, writePrivateFile } from '../src/platform/private-storage.js';
import { adoptPrivateFile } from '../src/platform/private-file-adoption.js';
it('private cross-directory adoption never replaces or deletes an existing destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'private-adoption-')); await establishPrivateDirectory(root);
    try {
        const incoming = join(root, 'incoming'); const owned = join(root, 'owned');
        await ensurePrivateDirectory(incoming); await ensurePrivateDirectory(owned);
        const source = join(incoming, 'source.pdf'); const target = join(owned, 'source.pdf');
        await writePrivateFile(source, 'source'); await writePrivateFile(target, 'existing');
        await expect(adoptPrivateFile(source, target)).rejects.toMatchObject({ code: 'EEXIST' });
        expect(await readFile(source, 'utf8')).toBe('source'); expect(await readFile(target, 'utf8')).toBe('existing');
        const next = join(owned, 'new.pdf'); await adoptPrivateFile(source, next);
        expect(await readFile(next, 'utf8')).toBe('source'); await expect(access(source)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
});
