import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Read local style entries in cascade order for existing source-contract assertions. */
export function readCssSource(path: string | URL): string {
  const url = typeof path === 'string' ? pathToFileURL(path) : path;
  return readFileSync(url, 'utf8').replace(
    /@import\s+['"]([^'"]+)['"]\s*;/gu,
    (_match, relative: string) => readCssSource(new URL(relative, url)),
  );
}
