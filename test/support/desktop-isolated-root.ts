import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { establishPrivateDirectory } from '../../apps/service/src/platform/private-storage.js';

/** The fixture owns this newly created directory, including its service credentials. */
export async function createDesktopIsolatedRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'placekeeper-desktop-test-'));
    try { await establishPrivateDirectory(root); return root; }
    catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
