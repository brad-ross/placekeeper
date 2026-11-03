import { link, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { syncDirectory } from '../files/durability.js';
import { verifyPrivatePath } from './private-storage.js';
import { requestWindowsNative } from './windows-native-worker.js';

/** Both names are service-contained private paths. Never replace a pre-existing
 * destination or delete either name after a failed/ambiguous native result.
 */
export async function adoptPrivateFile(source: string, destination: string): Promise<void> {
    if (resolve(source) === resolve(destination)) throw new Error('Private adoption requires distinct paths');
    await verifyPrivatePath(dirname(source), 'directory');
    await verifyPrivatePath(dirname(destination), 'directory');
    await verifyPrivatePath(source, 'file');
    if (process.platform === 'win32') {
        const result = await requestWindowsNative({ operation: 'adoptPrivateFile', candidate: source, target: destination });
        if (result.status === 'failed') throw Object.assign(new Error('Private adoption native move failed'), {
            code: result.nativeCode === 80 || result.nativeCode === 183 ? 'EEXIST' : result.nativeCode === 5 ? 'EACCES' : 'EIO', nativeCode: result.nativeCode,
        });
        if (result.status !== 'published') throw new Error('Private adoption native move was not confirmed');
    } else {
        await link(source, destination);
        await syncDirectory(dirname(destination));
        await unlink(source);
        await syncDirectory(dirname(source));
    }
    await verifyPrivatePath(destination, 'file');
}
