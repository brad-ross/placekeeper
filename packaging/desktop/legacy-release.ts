import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { WindowIntent } from '../../apps/electron/src/window-state.js';
const execute = promisify(execFile);
const scales = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
export function validatedLegacyInterfaceScale(value: unknown): number | undefined {
  return typeof value === 'number' && scales.includes(value) ? value : undefined;
}
/** Decode only the presentation fields published by AppKit, never session or capability data. */
export function parseLegacyMacPreferences(value: unknown): { windows: WindowIntent[]; interfaceScale?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { windows: [] };
  const preferences = value as Record<string, unknown>;
  const records = preferences['Placekeeper.RestorableDocumentWindows.v1'];
  const interfaceScale = validatedLegacyInterfaceScale(preferences['Placekeeper.AppZoom.v1']);
  const windows: WindowIntent[] = !Array.isArray(records) || records.length > 32 ? [] : records.flatMap((record: unknown): WindowIntent[] => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
    const item = record as Record<string, unknown>;
    if (Object.keys(item).some(key => !['sourcePath', 'frame', 'page', 'zoom'].includes(key))) return [];
    if (typeof item.sourcePath !== 'string' || !item.sourcePath.startsWith('/') || Buffer.byteLength(item.sourcePath) > 16384 || item.sourcePath.includes('\0') || !item.sourcePath.toLowerCase().endsWith('.pdf')) return [];
    if (typeof item.frame !== 'string' || Buffer.byteLength(item.frame) > 256) return [];
    const n = '([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?)';
    const match = new RegExp(`^\\{\\{\\s*${n}\\s*,\\s*${n}\\s*\\},\\s*\\{\\s*${n}\\s*,\\s*${n}\\s*\\}\\}$`, 'u').exec(item.frame);
    if (!match) return [];
    const [x, y, width, height] = match.slice(1).map(Number);
    if (![x, y, width, height].every(Number.isFinite) || width! < 480 || height! < 320 || width! > 16384 || height! > 16384) return [];
    if (item.page !== undefined && (typeof item.page !== 'number' || !Number.isSafeInteger(item.page) || item.page < 1)) return [];
    if (item.zoom !== undefined && (typeof item.zoom !== 'number' || !Number.isFinite(item.zoom) || item.zoom < 0.1 || item.zoom > 64)) return [];
    // AppKit has a bottom-left origin; the new shell places imported dimensions on a current display.
    return [{ sourcePath: item.sourcePath, bounds: { width: width!, height: height! }, maximized: false,
      ...(item.page !== undefined || item.zoom !== undefined ? { presentation: { pageIndex: typeof item.page === 'number' ? item.page - 1 : 0, zoom: typeof item.zoom === 'number' ? item.zoom : 1 } } : {}) }];
  });
  return { windows, ...(interfaceScale === undefined ? {} : { interfaceScale }) };
}
/** plutil handles both binary and XML UserDefaults files without modifying the original. */
export async function readLegacyMacPreferences(homeDirectory = homedir()): Promise<unknown> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(homeDirectory, 'Library/Preferences/local.placekeeper.plist')], { maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  } catch { return undefined; }
}
