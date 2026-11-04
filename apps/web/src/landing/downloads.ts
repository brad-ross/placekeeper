import { parseDesktopRelease, RELEASE_API_URL, type DesktopReleaseCatalog, type DesktopTarget } from '../../../../packages/core/src/desktop-release.js';

export type Downloads = { readonly status: 'loading' } | { readonly status: 'unavailable' } | { readonly status: 'available'; readonly catalog: DesktopReleaseCatalog };

export type BrowserDownloadHints = { readonly platform?: string; readonly maxTouchPoints?: number };

/** Mac identity defaults to Apple Silicon; Intel user-agent text does not establish the chip type. */
export function browserDownloadTarget(userAgent: string, hints: BrowserDownloadHints = {}): DesktopTarget | undefined {
  const identity = `${userAgent} ${hints.platform ?? ''}`;
  const isMac = /Macintosh|Mac OS/iu.test(userAgent) || /Mac/iu.test(hints.platform ?? '');
  if (/Android|iPhone|iPad|Mobile/iu.test(identity) || (isMac && (hints.maxTouchPoints ?? 0) > 1)) return undefined;
  if (/CrOS/iu.test(identity) || (/Windows|Linux/iu.test(identity) && /ARM|aarch64/iu.test(identity))) return undefined;
  if (/Windows/iu.test(userAgent) && /Win64|WOW64|x86_64/iu.test(userAgent)) return 'win32-x64';
  if (/Linux/iu.test(userAgent) && /x86_64/iu.test(userAgent)) return 'linux-x64';
  if (isMac) return 'darwin-arm64';
  return undefined;
}

export async function loadDownloads(fetcher: typeof fetch = fetch): Promise<Exclude<Downloads, { status: 'loading' }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(RELEASE_API_URL, { signal: controller.signal, credentials: 'omit', redirect: 'error', headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok || !response.body) throw Error('Release metadata unavailable');
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let body = '', bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1024 * 1024) throw Error('Release metadata too large');
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return { status: 'available', catalog: parseDesktopRelease(JSON.parse(body)) };
  } catch { return { status: 'unavailable' }; }
  finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => undefined); }
}
