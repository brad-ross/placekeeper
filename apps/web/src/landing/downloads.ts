import { parseDesktopRelease, RELEASE_API_URL, type DesktopReleaseCatalog, type DesktopTarget } from '../../../../packages/core/src/desktop-release.js';

export type Downloads = { readonly status: 'loading' } | { readonly status: 'unavailable' } | { readonly status: 'available'; readonly catalog: DesktopReleaseCatalog };

/** Browser Mac user agents report Intel even on Apple Silicon. Leave that choice to the user. */
export function browserDownloadTarget(userAgent: string): DesktopTarget | undefined {
  if (/Android|iPhone|iPad|Mobile/iu.test(userAgent)) return undefined;
  if (/Windows/iu.test(userAgent) && /Win64|WOW64|x86_64/iu.test(userAgent) && !/ARM|aarch64/iu.test(userAgent)) return 'win32-x64';
  if (/Linux/iu.test(userAgent) && /x86_64/iu.test(userAgent)) return 'linux-x64';
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
