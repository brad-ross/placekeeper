export interface WindowIntent {
    readonly sourcePath: string;
    readonly bounds: { readonly x?: number; readonly y?: number; readonly width: number; readonly height: number };
    readonly maximized: boolean;
    readonly presentation?: { readonly pageIndex: number; readonly zoom: number };
}
/** Decode a whitelist so session credentials can never survive restoration. */
export function parseWindowState(value: unknown): WindowIntent[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
        if (!item || typeof item !== 'object' || typeof item.sourcePath !== 'string' || item.sourcePath.length > 32768) return [];
        const b = item.bounds;
        if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return [];
        const p = item.presentation;
        return [{ sourcePath: item.sourcePath, bounds: {
            width: Math.max(600, Math.min(10000, b.width)), height: Math.max(400, Math.min(10000, b.height)),
            ...(Number.isFinite(b.x) ? { x: b.x } : {}), ...(Number.isFinite(b.y) ? { y: b.y } : {}),
        }, maximized: item.maximized === true,
        ...(p && Number.isInteger(p.pageIndex) && p.pageIndex >= 0 && Number.isFinite(p.zoom) && p.zoom > 0 && p.zoom <= 10 ? { presentation: { pageIndex: p.pageIndex, zoom: p.zoom } } : {}) }];
    });
}

import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
/** Restoration is disposable presentation state; corrupt or absent state must not block admission. */
export async function readWindowState(path: string): Promise<WindowIntent[]> {
    try { return parseWindowState(JSON.parse(await readFile(path, 'utf8'))); }
    catch { return []; }
}
/** A crash may leave an unused sibling, but never a truncated current state file. */
export async function writeWindowState(path: string, windows: readonly WindowIntent[]): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(parseWindowState(windows))); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
}
