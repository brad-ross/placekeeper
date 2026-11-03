import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

/** Locate the real query tool without assuming the CI TeX distribution's path. */
export function discoverSyncTexToolDirectory(): string | undefined {
  const pathKey = process.platform === 'win32'
    ? Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') : 'PATH';
  const path = pathKey === undefined ? '' : process.env[pathKey] ?? '';
  const directories = [...path.split(delimiter).filter(Boolean),
    ...(process.platform === 'darwin' ? ['/Library/TeX/texbin'] : [])];
  for (const directory of new Set(directories.map(directory => resolve(directory)))) {
    const executable = join(directory, process.platform === 'win32' ? 'synctex.exe' : 'synctex');
    try { accessSync(executable, constants.X_OK); } catch { continue; }
    const result = spawnSync(executable, ['help'], { timeout: 5000, encoding: 'utf8' });
    if (result.status === 0 && /synctex/iu.test(`${result.stdout ?? ''}${result.stderr ?? ''}`)) return directory;
  }
  return undefined;
}
