import { ALL_DOWNLOADS_URL, compareVersions, DESKTOP_TARGETS, desktopTarget, isSafeReleaseUrl, parseDesktopRelease, RELEASE_API_URL, type DesktopReleaseCatalog, type DesktopTarget } from '../../../packages/core/src/desktop-release.js';
export const MAX_RELEASE_BYTES = 1024 * 1024;
export const RELEASE_TIMEOUT_MS = 10000;
export type UpdateCheckResult = { readonly status: 'current' | 'newer' | 'ahead'; readonly catalog: DesktopReleaseCatalog } | { readonly status: 'unavailable' };
/** Called only by the native menu action; never downloads an installer. */
export async function checkForDesktopUpdate(installedVersion: string, fetcher: typeof fetch = fetch, timeoutMs = RELEASE_TIMEOUT_MS): Promise<UpdateCheckResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = async (): Promise<UpdateCheckResult> => {
        const response = await fetcher(RELEASE_API_URL, { signal: controller.signal, redirect: 'error', credentials: 'omit', headers: { Accept: 'application/vnd.github+json' } });
        if (!response.ok || !response.body) throw new Error('Release metadata unavailable');
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RELEASE_BYTES)) throw new Error('Release metadata too large');
        const reader = response.body.getReader();
        const cancelBody = () => { void reader.cancel().catch(() => undefined); };
        controller.signal.addEventListener('abort', cancelBody, { once: true });
        if (controller.signal.aborted) cancelBody();
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > MAX_RELEASE_BYTES) throw new Error('Release metadata too large');
                chunks.push(value);
            }
        } finally { controller.signal.removeEventListener('abort', cancelBody); cancelBody(); }
        const body = Buffer.concat(chunks, bytes);
        const catalog = parseDesktopRelease(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
        const comparison = compareVersions(installedVersion, catalog.version);
        return { status: comparison < 0 ? 'newer' : comparison > 0 ? 'ahead' : 'current', catalog };
    };
    try {
        return await Promise.race([request(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Release check timed out')); }, timeoutMs); })]);
    } catch { return { status: 'unavailable' }; }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
}
export interface UpdatePresentation { readonly title: string; readonly message: string; readonly detail: string; readonly buttons: string[]; readonly cancelId: number; readonly defaultId: number }
interface ManualUpdateOptions {
    readonly installedVersion: string;
    readonly platform: string;
    readonly architecture: string | undefined;
    readonly fetcher?: typeof fetch;
    readonly present: (options: UpdatePresentation) => Promise<number>;
    readonly openExternal: (url: string) => Promise<unknown>;
}
export function createManualUpdateAction(options: ManualUpdateOptions): () => Promise<void> {
    let busy = false;
    const navigate = async (url: string) => {
        if (!isSafeReleaseUrl(url)) throw new Error('Unsafe release link');
        await options.openExternal(url);
    };
    return async () => {
        if (busy) return;
        busy = true;
        try {
            const result = await checkForDesktopUpdate(options.installedVersion, options.fetcher);
            if (result.status === 'unavailable') {
                const choice = await options.present({ title: 'Check for updates', message: 'Updates could not be checked.', detail: 'The connection may be unavailable, or the latest release may not contain all supported desktop downloads. Try again later or view all downloads.', buttons: ['Close', 'All Downloads'], defaultId: 0, cancelId: 0 });
                if (choice === 1) await navigate(ALL_DOWNLOADS_URL);
                return;
            }
            const { catalog } = result;
            const target = desktopTarget(options.platform, options.architecture);
            const newer = result.status === 'newer';
            const choice = await options.present({ title: 'Check for updates', message: newer ? `Placekeeper ${catalog.version} is available.` : result.status === 'ahead' ? `Your installed version (${options.installedVersion}) is newer than the latest stable release (${catalog.version}).` : `Placekeeper ${options.installedVersion} is up to date.`, detail: newer ? `Installed: ${options.installedVersion}. Download and install the new version manually. Your browser will open only after you choose a link. ${target ? DESKTOP_TARGETS[target].guidance : 'Choose your operating system and architecture to download.'}` : 'Release notes and all downloads are available in your browser.', buttons: newer ? [target ? `Download for ${DESKTOP_TARGETS[target].label}` : 'Choose Download…', 'Release Notes', 'All Downloads', 'Close'] : ['Close', 'Release Notes', 'All Downloads'], defaultId: 0, cancelId: newer ? 3 : 0 });
            if (choice === 1) await navigate(catalog.notesUrl);
            else if (choice === 2) await navigate(ALL_DOWNLOADS_URL);
            else if (newer && choice === 0) {
                let selected: DesktopTarget | undefined = target;
                if (!selected) {
                    const targets = Object.keys(DESKTOP_TARGETS) as DesktopTarget[];
                    const selection = await options.present({ title: 'Choose a download', message: 'Select the computer where Placekeeper will be installed.', detail: 'macOS: choose Apple Silicon or Intel from About This Mac. Linux downloads support Ubuntu / Debian x64.', buttons: [...targets.map(key => DESKTOP_TARGETS[key].label), 'All Downloads', 'Cancel'], defaultId: 5, cancelId: 5 });
                    if (selection === 4) { await navigate(ALL_DOWNLOADS_URL); return; }
                    selected = targets[selection];
                }
                if (selected) await navigate(catalog.downloads[selected].url);
            }
        } catch {
            await options.present({ title: 'Check for updates', message: 'The release link could not be opened.', detail: 'Try again after checking your browser settings.', buttons: ['Close'], defaultId: 0, cancelId: 0 }).catch(() => undefined);
        } finally { busy = false; }
    };
}
