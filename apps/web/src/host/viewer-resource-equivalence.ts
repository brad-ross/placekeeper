import type { ViewerAssetUrls, ViewerResourcePolicy } from '../pdf/embedpdf-viewer.js';

function equalStringRecord(
  first: Readonly<Record<string, string>> | undefined,
  second: Readonly<Record<string, string>> | undefined,
): boolean {
  if (first === second) return true;
  if (first === undefined || second === undefined) return false;
  const firstEntries = Object.entries(first);
  const secondKeys = Object.keys(second);
  return firstEntries.length === secondKeys.length
    && firstEntries.every(([key, value]) => second[key] === value);
}

export function viewerAssetUrlsEqual(
  first: ViewerAssetUrls | undefined,
  second: ViewerAssetUrls | undefined,
): boolean {
  return first === second || (
    first !== undefined
    && second !== undefined
    && first.pdfiumWasm === second.pdfiumWasm
    && first.workerUrl === second.workerUrl
    && first.documentUrl === second.documentUrl
    && equalStringRecord(first.requestHeaders, second.requestHeaders)
  );
}

export function viewerResourcePoliciesEqual(
  first: ViewerResourcePolicy | undefined,
  second: ViewerResourcePolicy | undefined,
): boolean {
  if (first === second) return true;
  if (first === undefined || second === undefined || first.host !== second.host) return false;
  if (first.host === 'browser' && second.host === 'browser') return first.origin === second.origin;
  if (first.host === 'vscode' && second.host === 'vscode') {
    return first.issued.size === second.issued.size
      && [...first.issued].every((url) => second.issued.has(url));
  }
  if (first.host === 'chrome' && second.host === 'chrome') {
    return first.extensionOrigin === second.extensionOrigin
      && first.resources.document === second.resources.document
      && first.resources.pdfiumWasm === second.resources.pdfiumWasm
      && first.resources.worker === second.resources.worker;
  }
  return first.host === 'macos' && second.host === 'macos'
    && first.resources.document === second.resources.document
    && first.resources.pdfiumWasm === second.resources.pdfiumWasm
    && first.resources.worker === second.resources.worker;
}
